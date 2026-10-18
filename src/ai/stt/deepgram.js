import fs from 'node:fs';
import WebSocket from 'ws';
import { env } from '../../config/env.js';
import { fetchJson } from '../../lib/http.js';
import { AppError } from '../../lib/AppError.js';
import { logger } from '../../lib/logger.js';
import { speakerLabel } from '../../lib/text.js';

const BASE = 'api.deepgram.com/v1/listen';

// new run on every speaker change; optionally also on long pauses and after long sentences
function splitBySpeaker(words, offset, { maxGap = Infinity, maxWords = Infinity } = {}) {
  const runs = [];
  for (const w of words) {
    const speaker = speakerLabel(w.speaker ?? 0);
    const last = runs[runs.length - 1];
    const token = w.punctuated_word ?? w.word;
    const pause = last ? w.start + offset - last.end : 0;
    const longSentenceDone = last && last.words.length >= maxWords && /[.?!]$/.test(last.words[last.words.length - 1]);
    if (last && last.speaker === speaker && pause <= maxGap && !longSentenceDone) {
      last.words.push(token);
      last.end = w.end + offset;
      last.conf.push(w.confidence ?? 0.9);
    } else {
      runs.push({ speaker, words: [token], start: w.start + offset, end: w.end + offset, conf: [w.confidence ?? 0.9] });
    }
  }
  return runs.map((r) => ({
    speaker: r.speaker,
    text: r.words.join(' '),
    start: r.start,
    end: r.end,
    confidence: r.conf.reduce((a, b) => a + b, 0) / r.conf.length,
  }));
}

const SINGLE_LANGUAGES = new Set(['en', 'hi', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'ja']);

function listen(filePath, mimeType, language) {
  const params = new URLSearchParams({
    model: env.DEEPGRAM_MODEL,
    language,
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
  });
  return fetchJson(
    `https://${BASE}?${params}`,
    {
      method: 'POST',
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'Content-Type': mimeType || 'audio/webm' },
      body: fs.createReadStream(filePath),
      duplex: 'half',
    },
    { provider: 'Deepgram', timeoutMs: Math.max(env.AI_TIMEOUT_MS, 10 * 60 * 1000) }
  );
}

const wordsOf = (json) => json.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
const speakerCount = (words) => new Set(words.map((w) => w.speaker ?? 0)).size;

// multilingual results tag every word with its language
function mainLanguage(words) {
  const counts = new Map();
  for (const w of words) if (w.language) counts.set(w.language, (counts.get(w.language) ?? 0) + 1);
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return SINGLE_LANGUAGES.has(top) ? top : 'en';
}

// take speaker labels from another pass over the same audio, matching words by time
function applySpeakers(words, reference) {
  let j = 0;
  return words.map((w) => {
    const mid = (w.start + w.end) / 2;
    while (j < reference.length - 1 && reference[j].end < mid) j++;
    return { ...w, speaker: reference[j]?.speaker ?? w.speaker };
  });
}

const normWord = (t = '') => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

// live timestamps can be slightly off from the file's; estimate the shift by finding each
// live segment's first word in the final words and taking the median difference
function liveOffset(words, segs) {
  const diffs = [];
  for (const s of segs) {
    const first = normWord(s.text.split(/\s+/)[0]);
    if (!first) continue;
    let best = null;
    for (const w of words) {
      if (Math.abs(w.start - s.start) > 3 || normWord(w.word) !== first) continue;
      if (!best || Math.abs(w.start - s.start) < Math.abs(best.start - s.start)) best = w;
    }
    if (best) diffs.push(best.start - s.start);
  }
  if (!diffs.length) return 0;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

// take speakers from the live transcript of the same recording, matching each word to the live segment at that time
function applyLiveSpeakers(words, liveSegments) {
  const sorted = [...liveSegments].sort((a, b) => a.start - b.start);
  const shift = liveOffset(words, sorted);
  const segs = sorted.map((s) => ({ ...s, start: s.start + shift, end: s.end + shift }));
  const index = new Map();
  let j = 0;
  return words.map((w) => {
    const mid = (w.start + w.end) / 2;
    while (j < segs.length - 1 && segs[j].end < mid) j++;
    let seg = segs[j];
    if (j > 0 && mid < seg.start && seg.start - mid > mid - segs[j - 1].end) seg = segs[j - 1];
    if (!index.has(seg.speaker)) index.set(seg.speaker, index.size);
    return { ...w, speaker: index.get(seg.speaker) };
  });
}

export async function transcribeFile({ filePath, mimeType, liveSegments = [] }) {
  const json = await listen(filePath, mimeType, env.STT_LANGUAGE);
  let words = wordsOf(json);

  // nova-3 in multilingual mode sometimes puts every word on one speaker. A single-language
  // pass separates speakers reliably, so use it for the speaker labels and keep the multilingual text
  if (env.STT_LANGUAGE === 'multi' && words.length >= 20 && speakerCount(words) === 1) {
    try {
      const reference = wordsOf(await listen(filePath, mimeType, mainLanguage(words)));
      if (speakerCount(reference) > 1) words = applySpeakers(words, reference);
    } catch (err) {
      logger.warn('Speaker re-check failed, keeping single speaker', { error: err.message });
    }
  }

  // the full-file pass can still miss a short second speaker that the live pass caught
  if (words.length && speakerCount(words) === 1 && new Set(liveSegments.map((s) => s.speaker)).size > 1) {
    words = applyLiveSpeakers(words, liveSegments);
  }

  // built from per-word speakers: Deepgram's utterances can span a speaker change and hide it
  return {
    segments: splitBySpeaker(words, 0, { maxGap: 1.5, maxWords: 40 }).filter((s) => s.text.trim()),
    durationSec: json.metadata?.duration,
    language: env.STT_LANGUAGE === 'multi' ? mainLanguage(words) : (json.results?.channels?.[0]?.detected_language ?? env.STT_LANGUAGE),
  };
}

export function createLiveSession({ onTranscript, onError, timeOffsetSec = 0 }) {
  const params = new URLSearchParams({
    model: env.DEEPGRAM_MODEL,
    language: env.STT_LANGUAGE,
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: '300',
  });
  const ws = new WebSocket(`wss://${BASE}?${params}`, { headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` } });
  const pending = [];
  let open = false;
  let lastAudioAt = Date.now();

  ws.on('open', () => {
    open = true;
    for (const buf of pending.splice(0)) ws.send(buf);
  });
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type !== 'Results') return;
    const alt = msg.channel?.alternatives?.[0];
    if (!alt?.transcript?.trim()) return;
    const runs = splitBySpeaker(alt.words ?? [], timeOffsetSec);
    if (!runs.length) return;
    if (msg.is_final) {
      for (const run of runs) onTranscript({ ...run, isFinal: true });
    } else {
      const last = runs[runs.length - 1];
      onTranscript({ ...last, text: runs.map((r) => r.text).join(' '), start: runs[0].start, isFinal: false });
    }
  });
  ws.on('unexpected-response', (_req, res) => {
    const msg = res.statusCode === 401 ? 'Deepgram rejected the API key.' : `Deepgram refused the connection (HTTP ${res.statusCode}).`;
    onError(new AppError(502, 'LIVE_STT_UNAVAILABLE', msg));
    ws.terminate();
  });
  ws.on('error', (err) => onError(new AppError(503, 'LIVE_STT_UNAVAILABLE', `Live transcription connection failed: ${err.message}`)));

  return {
    provider: 'deepgram',
    send(buf) {
      lastAudioAt = Date.now();
      if (open && ws.readyState === WebSocket.OPEN) ws.send(buf);
      else if (pending.length < 200) pending.push(buf);
    },
    setActivity() {},
    keepAlive() {
      if (open && ws.readyState === WebSocket.OPEN && Date.now() - lastAudioAt > 4000) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    },
    finish() {
      return new Promise((resolve) => {
        if (!open || ws.readyState !== WebSocket.OPEN) {
          ws.terminate();
          return resolve();
        }
        const timer = setTimeout(() => {
          ws.terminate();
          resolve();
        }, 4000);
        ws.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      });
    },
    close() {
      ws.terminate();
    },
  };
}
