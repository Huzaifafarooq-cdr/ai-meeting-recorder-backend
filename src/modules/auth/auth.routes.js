import { Router } from 'express';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/AppError.js';
import { requireAuth } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimiters.js';
import { validate } from '../../middleware/validate.js';
import * as auth from './auth.service.js';

const COOKIE = 'rt';
const cookieOptions = {
  httpOnly: true,
  secure: isProd || env.COOKIE_SAMESITE === 'none',
  sameSite: env.COOKIE_SAMESITE,
  path: '/api/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000,
};

const email = z.string().trim().toLowerCase().email('Please enter a valid email address.').max(254);
const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters.').max(80),
  email,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters.')
    .max(128)
    .regex(/[A-Za-z]/, 'Password must contain a letter.')
    .regex(/\d/, 'Password must contain a number.'),
});
const loginSchema = z.object({ email, password: z.string().min(1, 'Password is required.').max(128) });

// CSRF: cookie endpoints need a custom header
function requireCsrfHeader(req, _res, next) {
  if (req.get('X-Requested-With') !== 'XMLHttpRequest') return next(new AppError(403, 'CSRF_CHECK_FAILED', 'Missing request header.'));
  next();
}

function sendSession(res, status, { user, accessToken, refreshToken }) {
  res.cookie(COOKIE, refreshToken, cookieOptions);
  res.status(status).json({ user, accessToken });
}

const meta = (req) => ({ userAgent: req.get('user-agent') });

export const authRouter = Router();

authRouter.post(
  '/register',
  authLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => sendSession(res, 201, await auth.register(req.body, meta(req))))
);

authRouter.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => sendSession(res, 200, await auth.login(req.body, meta(req))))
);

authRouter.post(
  '/refresh',
  requireCsrfHeader,
  asyncHandler(async (req, res) => {
    try {
      sendSession(res, 200, await auth.refresh(req.cookies?.[COOKIE], meta(req)));
    } catch (err) {
      if (err.status === 401) res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
      throw err;
    }
  })
);

authRouter.post(
  '/logout',
  requireCsrfHeader,
  asyncHandler(async (req, res) => {
    await auth.logout(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
    res.status(204).end();
  })
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => res.json({ user: await auth.getUser(req.user.id) }))
);
