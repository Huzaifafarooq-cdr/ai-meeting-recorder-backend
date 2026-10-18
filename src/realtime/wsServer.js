import mongoose from 'mongoose';
import { WebSocketServer } from 'ws';
import { allowedOrigins } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { subscribeUser } from './eventBus.js';
import { handleLiveConnection } from './liveHandler.js';

const PING_MS = 25_000;

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function handleEventsConnection(ws, { user }) {
  const unsubscribe = subscribeUser(user.id, (event) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  });
  ws.on('close', unsubscribe);
  ws.send(JSON.stringify({ type: 'hello' }));
}

// /ws/live and /ws/events, token checked on upgrade
export function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/live' && url.pathname !== '/ws/events') return reject(socket, 404, 'Not Found');

    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return reject(socket, 403, 'Forbidden');

    let user;
    try {
      user = verifyAccessToken(url.searchParams.get('token'));
    } catch {
      return reject(socket, 401, 'Unauthorized');
    }

    const recordingId = url.searchParams.get('recordingId');
    if (url.pathname === '/ws/live' && !mongoose.isValidObjectId(recordingId)) return reject(socket, 400, 'Bad Request');

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      ws.on('error', (err) => logger.warn('WebSocket error', { error: err.message }));
      if (url.pathname === '/ws/live') {
        const timeOffsetSec = Number(url.searchParams.get('t')) || 0;
        handleLiveConnection(ws, { user, recordingId, timeOffsetSec }).catch((err) => {
          logger.error('Live connection failed', { error: err.message });
          ws.close(1011, 'Server error');
        });
      } else {
        handleEventsConnection(ws, { user });
      }
    });
  });

  // ping to detect dead connections
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_MS);
  wss.on('close', () => clearInterval(interval));
  return wss;
}
