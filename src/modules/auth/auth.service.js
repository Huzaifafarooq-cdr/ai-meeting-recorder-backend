import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { User } from '../../models/User.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { AppError, conflict } from '../../lib/AppError.js';
import { hashToken, newRefreshToken, signAccessToken } from './tokens.js';

const BCRYPT_ROUNDS = 12;
const REFRESH_GRACE_MS = 15_000;
const TIMING_HASH = bcrypt.hashSync('no-such-user', BCRYPT_ROUNDS);

async function issueSession(user, { userAgent, family = crypto.randomUUID() } = {}) {
  const refreshToken = newRefreshToken();
  await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(refreshToken),
    family,
    userAgent: userAgent?.slice(0, 300),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000),
  });
  return { user: user.toPublic(), accessToken: signAccessToken(user._id), refreshToken };
}

export async function register({ name, email, password }, meta) {
  if (await User.exists({ email })) throw conflict('EMAIL_IN_USE', 'An account with this email already exists. Try logging in instead.');
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await User.create({ name, email, passwordHash });
  return issueSession(user, meta);
}

export async function login({ email, password }, meta) {
  const user = await User.findOne({ email }).select('+passwordHash');
  const ok = await bcrypt.compare(password, user?.passwordHash ?? TIMING_HASH);
  if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
  return issueSession(user, meta);
}

export async function refresh(rawToken, meta) {
  if (!rawToken) throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');
  const stored = await RefreshToken.findOne({ tokenHash: hashToken(rawToken) });
  if (!stored || stored.expiresAt < new Date()) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');
  }
  if (stored.revokedAt && Date.now() - stored.revokedAt.getTime() < REFRESH_GRACE_MS) {
    throw new AppError(409, 'REFRESH_CONFLICT', 'Session is being refreshed, please retry.');
  }
  if (stored.revokedAt) {
    await RefreshToken.updateMany({ family: stored.family, revokedAt: null }, { revokedAt: new Date() });
    throw new AppError(401, 'SESSION_REVOKED', 'For your security this session was ended. Please log in again.');
  }
  const user = await User.findById(stored.user);
  if (!user) throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');

  const claimed = await RefreshToken.updateOne({ _id: stored._id, revokedAt: null }, { revokedAt: new Date() });
  if (!claimed.modifiedCount) throw new AppError(409, 'REFRESH_CONFLICT', 'Session is being refreshed, please retry.');
  return issueSession(user, { ...meta, family: stored.family });
}

export async function logout(rawToken) {
  if (!rawToken) return;
  await RefreshToken.updateOne({ tokenHash: hashToken(rawToken), revokedAt: null }, { revokedAt: new Date() });
}

export async function getUser(id) {
  const user = await User.findById(id);
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Please log in to continue.');
  return user.toPublic();
}
