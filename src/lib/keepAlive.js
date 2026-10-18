import { logger } from './logger.js';

let timer = null;

export function startKeepAlive(baseUrl, intervalMs = 10 * 60 * 1000) {
  if (!baseUrl) return;
  const url = `${baseUrl.replace(/\/$/, '')}/api/health`;
  timer = setInterval(() => {
    fetch(url, { signal: AbortSignal.timeout(15_000) }).catch((err) => logger.warn('Keep-alive ping failed', { error: err.message }));
  }, intervalMs);
  timer.unref();
  logger.info('Keep-alive enabled', { url });
}

export function stopKeepAlive() {
  clearInterval(timer);
}
