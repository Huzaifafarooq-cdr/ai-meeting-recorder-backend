import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { logger } from './lib/logger.js';
import { startKeepAlive, stopKeepAlive } from './lib/keepAlive.js';
import { createApp } from './app.js';
import { attachWebSocketServer } from './realtime/wsServer.js';
import { startRelayListener, stopRelayListener } from './realtime/eventBus.js';
import { ensureStorage, TMP_DIR } from './storage/index.js';
import { startWorker, stopWorker } from './jobs/queue.js';
import { startSweeper, stopSweeper, sweepAbandonedRecordings } from './jobs/sweeper.js';

async function cleanTmp() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const name of await fsp.readdir(TMP_DIR).catch(() => [])) {
    const file = path.join(TMP_DIR, name);
    const info = await fsp.stat(file).catch(() => null);
    if (info && info.mtimeMs < cutoff) await fsp.rm(file, { force: true });
  }
}

async function main() {
  await connectDB();
  await ensureStorage();
  await cleanTmp();

  const server = http.createServer(createApp());
  attachWebSocketServer(server);
  server.requestTimeout = 30 * 60 * 1000;

  await startRelayListener();
  if (env.RUN_WORKER) startWorker();
  startSweeper();
  sweepAbandonedRecordings().catch(() => {});

  server.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}`);
    startKeepAlive(env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully…`);
    stopSweeper();
    stopKeepAlive();
    stopRelayListener();
    server.close();
    await stopWorker();
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(`Failed to start: ${err.message}`);
  process.exit(1);
});
