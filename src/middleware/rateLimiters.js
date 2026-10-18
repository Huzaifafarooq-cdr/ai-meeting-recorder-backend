import rateLimit from 'express-rate-limit';

const handler = (message) => (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } });

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: handler('Too many attempts. Please wait a few minutes and try again.'),
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: handler('Too many requests. Please slow down.'),
});

export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: handler('Upload limit reached. Please try again later.'),
});
