import { ZodError } from 'zod';
import multer from 'multer';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { AppError } from '../lib/AppError.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

function normalize(err) {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return new AppError(400, 'VALIDATION_ERROR', details[0]?.message ?? 'Invalid request.', { details });
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return new AppError(413, 'FILE_TOO_LARGE', `The file is larger than the ${env.MAX_UPLOAD_MB} MB limit. Try compressing it or splitting the recording.`);
    }
    return new AppError(400, 'UPLOAD_ERROR', `Upload failed: ${err.message}`);
  }
  if (err instanceof mongoose.Error.CastError) return new AppError(404, 'NOT_FOUND', 'Resource not found.');
  if (err?.code === 11000) return new AppError(409, 'DUPLICATE', 'This record already exists.');
  if (err?.type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  if (err?.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  return null;
}

export function errorHandler(err, req, res, _next) {
  const appErr = normalize(err);
  if (!appErr) {
    logger.error('Unhandled error', { method: req.method, path: req.path, error: err?.message, stack: err?.stack });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' } });
  }
  if (appErr.status >= 500) logger.error(appErr.message, { code: appErr.code, path: req.path });
  res.status(appErr.status).json({ error: { code: appErr.code, message: appErr.message, details: appErr.details } });
}
