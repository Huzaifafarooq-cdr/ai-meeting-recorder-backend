import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/ai_meeting_recorder'),
  USE_IN_MEMORY_DB: bool.default('false'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_MEDIA_SECRET: z.string().min(32, 'JWT_MEDIA_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().positive().default(7),
  MEDIA_TOKEN_TTL: z.string().default('30m'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(200),

  DEEPGRAM_API_KEY: z.string().min(1, 'DEEPGRAM_API_KEY is required'),
  DEEPGRAM_MODEL: z.string().default('nova-3'),
  STT_LANGUAGE: z.string().default('en'),

  LLM_API_KEY: z.string().min(1, 'LLM_API_KEY is required'),
  LLM_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai/'),
  LLM_MODEL: z.string().default('gemini-flash-lite-latest'),

  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  LLM_CONCURRENCY: z.coerce.number().int().positive().default(4),
  RUN_WORKER: bool.default('true'),
  KEEP_ALIVE_URL: z.string().url().optional().or(z.literal('')),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const allowedOrigins = env.CLIENT_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function isAllowedOrigin(origin) {
  return allowedOrigins.includes(origin) || (!isProd && LOCAL_ORIGIN.test(origin));
}
