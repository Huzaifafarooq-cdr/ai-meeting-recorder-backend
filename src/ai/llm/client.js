import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { fetchJson, sleep } from '../../lib/http.js';
import { createLimiter, mapLimit } from '../../lib/concurrency.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../lib/AppError.js';
import { ACTIONS_SYSTEM, CLEAN_SYSTEM, INSIGHTS_SYSTEM, NOTES_SYSTEM, SPEAKERS_SYSTEM, SUMMARY_SYSTEM } from './prompts.js';

const MAX_CHARS = 48_000;

const KNOWN_PROVIDERS = [
  [/googleapis\.com/, 'Gemini'],
  [/groq\.com/, 'Groq'],
  [/azure\.com/, 'Azure OpenAI'],
  [/openai\.com/, 'OpenAI'],
];
const PROVIDER = KNOWN_PROVIDERS.find(([re]) => re.test(env.LLM_BASE_URL))?.[1] ?? 'The AI provider';

const limit = createLimiter(env.LLM_CONCURRENCY);
const RATE_LIMIT_RETRIES = 3;
const MAX_INLINE_WAIT_MS = 60_000;

async function chatJson(system, user) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await limit(() => requestChat(system, user));
    } catch (err) {
      const wait = err.code === 'AI_RATE_LIMITED' ? (err.retryAfterMs ?? 5000 * 2 ** attempt) : Infinity;
      if (attempt >= RATE_LIMIT_RETRIES || wait > MAX_INLINE_WAIT_MS) throw err;
      logger.warn(`${PROVIDER} rate limited, waiting before retry`, { waitMs: wait, attempt: attempt + 1 });
      await sleep(wait + Math.random() * 1000);
    }
  }
}

async function requestChat(system, user) {
  const json = await fetchJson(
    `${env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    },
    { provider: PROVIDER }
  );
  const content = json.choices?.[0]?.message?.content;
  try {
    return JSON.parse(content);
  } catch {
    throw new AppError(502, 'AI_BAD_RESPONSE', 'The AI returned an unreadable response.', { retryable: true });
  }
}

async function condense(transcript) {
  const chunks = [];
  for (let i = 0; i < transcript.length; i += MAX_CHARS) chunks.push(transcript.slice(i, i + MAX_CHARS));
  const notes = await mapLimit(chunks, env.LLM_CONCURRENCY, async (chunk, i) => {
    const res = await chatJson(NOTES_SYSTEM, `Part ${i + 1} of ${chunks.length}:\n\n${chunk}`);
    return `Part ${i + 1} notes:\n${res.notes ?? ''}`;
  });
  return fit(notes.join('\n\n'));
}

const condenseCache = new Map();
const CONDENSE_CACHE_SIZE = 8;
function fit(transcript) {
  if (transcript.length <= MAX_CHARS) return Promise.resolve(transcript);
  const key = createHash('sha1').update(transcript).digest('hex');
  let pending = condenseCache.get(key);
  if (!pending) {
    pending = condense(transcript);
    pending.catch(() => condenseCache.delete(key));
    condenseCache.set(key, pending);
    if (condenseCache.size > CONDENSE_CACHE_SIZE) condenseCache.delete(condenseCache.keys().next().value);
  }
  return pending;
}

const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);

export async function cleanSegments(segments) {
  const res = await chatJson(CLEAN_SYSTEM, JSON.stringify({ segments }));
  const out = {};
  for (const s of res.segments ?? []) if (s && typeof s.id === 'string' && typeof s.text === 'string') out[s.id] = s.text.trim();
  return out;
}

export async function summarize(transcript) {
  const res = await chatJson(SUMMARY_SYSTEM, await fit(transcript));
  if (!res.overview) throw new AppError(502, 'AI_BAD_RESPONSE', 'The AI returned an empty summary.', { retryable: true });
  return { overview: String(res.overview), topics: strings(res.topics), decisions: strings(res.decisions), outcome: String(res.outcome ?? '') };
}

export async function extractActions(transcript) {
  const res = await chatJson(ACTIONS_SYSTEM, await fit(transcript));
  const actionItems = (Array.isArray(res.actionItems) ? res.actionItems : [])
    .filter((a) => a?.text)
    .map((a) => ({ text: String(a.text), owner: a.owner ? String(a.owner) : undefined, due: a.due ? String(a.due) : undefined }));
  return { actionItems, keyDecisions: strings(res.keyDecisions) };
}

// lines: [{ text, pause }] in order. Returns one speaker index per line, or null if the answer doesn't fit
export async function inferSpeakers(lines) {
  const input = lines.map((l, i) => `${i + 1}. (pause ${l.pause.toFixed(1)}s) ${l.text}`).join('\n');
  const res = await chatJson(SPEAKERS_SYSTEM, input);
  const speakers = res.speakers;
  if (!Array.isArray(speakers) || speakers.length !== lines.length) return null;
  if (!speakers.every((s) => Number.isInteger(s) && s >= 0 && s < 10)) return null;
  return speakers;
}

export async function generateInsights(transcript) {
  const res = await chatJson(INSIGHTS_SYSTEM, await fit(transcript));
  return { title: String(res.title ?? '').slice(0, 120), keywords: strings(res.keywords).slice(0, 12) };
}
