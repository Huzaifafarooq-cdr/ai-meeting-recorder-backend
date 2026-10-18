import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { allowedOrigins, env } from './config/env.js';
import { isDbReady } from './config/db.js';
import { logger } from './lib/logger.js';
import { requireAuth } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimiters.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { recordingsRouter } from './modules/recordings/recordings.routes.js';
import { mediaRouter } from './modules/media/media.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    res.on('finish', () => {
      if (path === '/api/health') return;
      const ms = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : ms > 1000 ? 'warn' : 'debug';
      logger[level](`${req.method} ${path} ${res.statusCode} ${ms}ms`);
    });
    next();
  });

  app.get('/api/health', (_req, res) => {
    const ok = isDbReady();
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      db: ok ? 'connected' : 'disconnected',
      maxUploadMb: env.MAX_UPLOAD_MB,
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/recordings', apiLimiter, requireAuth, recordingsRouter);
  app.use('/api/media', mediaRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
