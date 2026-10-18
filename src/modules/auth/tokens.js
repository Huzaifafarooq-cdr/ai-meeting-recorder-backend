import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/AppError.js';

const ISSUER = 'ai-meeting-recorder';

export function signAccessToken(userId) {
  return jwt.sign({ typ: 'access' }, env.JWT_ACCESS_SECRET, {
    subject: userId.toString(),
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: ISSUER,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token) {
  if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'Please log in to continue.');
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: ISSUER, algorithms: ['HS256'] });
    if (payload.typ !== 'access') throw new Error('wrong token type');
    return { id: payload.sub };
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new AppError(401, 'TOKEN_EXPIRED', 'Your session has expired.');
    throw new AppError(401, 'INVALID_TOKEN', 'Invalid authentication token.');
  }
}

export function signMediaToken(userId, recordingId) {
  return jwt.sign({ typ: 'media', rid: recordingId.toString() }, env.JWT_MEDIA_SECRET, {
    subject: userId.toString(),
    expiresIn: env.MEDIA_TOKEN_TTL,
    issuer: ISSUER,
    algorithm: 'HS256',
  });
}

export function verifyMediaToken(token, recordingId) {
  try {
    const payload = jwt.verify(token ?? '', env.JWT_MEDIA_SECRET, { issuer: ISSUER, algorithms: ['HS256'] });
    if (payload.typ !== 'media' || payload.rid !== recordingId) throw new Error('scope mismatch');
    return { userId: payload.sub };
  } catch {
    throw new AppError(401, 'INVALID_MEDIA_TOKEN', 'This playback link has expired. Reload the page to get a new one.');
  }
}

export const newRefreshToken = () => crypto.randomBytes(48).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
