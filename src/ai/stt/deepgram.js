import fs from 'node:fs';
import WebSocket from 'ws';
import { env } from '../../config/env.js';
import { fetchJson } from '../../lib/http.js';
import { AppError } from '../../lib/AppError.js';
import { speakerLabel } from '../../lib/text.js';

const BASE = 'api.deepgram.com/v1/listen';

// split words into turns by speaker
function splitBySpeaker(words, offset) {
  const runs = [];
  for (const w of words) {
    const speaker = speakerLabel(w.speaker ?? 0);
    const last = runs[runs.length - 1];
    const token = w.punctuated_word ?? w.word;
    if (last && last.speaker === speaker) {
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

export async function transcribeFile({ filePath, mimeType }) {
  const params = new URLSearchParams({
    model: env.DEEPGRAM_MODEL,
    language: env.STT_LANGUAGE,
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    utterances: 'true',
  });
  const json = await fetchJson(
    `https://${BASE}?${params}`,
    {
      method: 'POST',
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'Content-Type': mimeType || 'audio/webm' },
      body: fs.createReadStream(filePath),
      duplex: 'half',
    },
    { provider: 'Deepgram', timeoutMs: Math.max(env.AI_TIMEOUT_MS, 10 * 60 * 1000) }
  );

  const utterances = json.results?.utterances ?? [];
  return {
    segments: utterances
      .filter((u) => u.transcript?.trim())
      .map((u) => ({ speaker: speakerLabel(u.speaker), start: u.start, end: u.end, text: u.transcript, confidence: u.confidence })),
    durationSec: json.metadata?.duration,
    language: json.results?.channels?.[0]?.detected_language ?? env.STT_LANGUAGE,
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
      // interim result
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
      // keepalive, deepgram closes idle streams after ~10s
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
