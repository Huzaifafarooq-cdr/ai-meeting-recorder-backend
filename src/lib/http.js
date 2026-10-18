import { env } from '../config/env.js';
import { AppError } from './AppError.js';

// retry delay from Retry-After header or gemini error body
function retryAfterMs(headers, body) {
  const header = Number(headers?.get?.('retry-after'));
  if (header > 0) return header * 1000;
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) ?? body.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

function providerHttpError(provider, status, body, headers) {
  if (status === 401 || status === 403) {
    return new AppError(502, 'AI_AUTH_FAILED', `${provider} rejected the API key. Please check the server configuration.`);
  }
  if (status === 429) {
    // daily quota, no point retrying
    if (/PerDay/i.test(body)) {
      return new AppError(503, 'AI_QUOTA_EXCEEDED', `${provider}'s daily quota for this API key is used up. Try again tomorrow or use a key with a higher limit.`);
    }
    const error = new AppError(503, 'AI_RATE_LIMITED', `${provider} is rate limiting requests. Retrying shortly.`, { retryable: true });
    error.retryAfterMs = retryAfterMs(headers, body);
    return error;
  }
  if (status === 413) {
    return new AppError(413, 'AUDIO_TOO_LARGE', `The audio file is too large for ${provider} to process.`);
  }
  if (status >= 500) {
    return new AppError(503, 'AI_UNAVAILABLE', `${provider} is temporarily unavailable (HTTP ${status}).`, { retryable: true });
  }
  return new AppError(502, 'AI_REQUEST_FAILED', `${provider} could not process the request (HTTP ${status}): ${body.slice(0, 200)}`);
}

export async function fetchJson(url, options = {}, { provider = 'AI provider', timeoutMs = env.AI_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw providerHttpError(provider, res.status, await res.text().catch(() => ''), res.headers);
    return await res.json();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err.name === 'AbortError') {
      throw new AppError(504, 'AI_TIMEOUT', `${provider} did not respond within ${Math.round(timeoutMs / 1000)} seconds.`, {
        retryable: true,
      });
    }
    if (err instanceof SyntaxError) {
      throw new AppError(502, 'AI_BAD_RESPONSE', `${provider} returned an unreadable response.`, { retryable: true });
    }
    throw new AppError(503, 'AI_UNAVAILABLE', `Could not reach ${provider}. The service may be down or the network is unavailable.`, {
      retryable: true,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
