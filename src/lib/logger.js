import { isProd } from '../config/env.js';

function write(level, message, meta) {
  if (isProd) {
    console[level === 'debug' ? 'log' : level](JSON.stringify({ level, time: new Date().toISOString(), message, ...meta }));
    return;
  }
  const time = new Date().toISOString().slice(11, 19);
  const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  console[level === 'debug' ? 'log' : level](`[${time}] ${level.toUpperCase().padEnd(5)} ${message}${extra}`);
}

export const logger = {
  debug: (msg, meta) => !isProd && write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};
