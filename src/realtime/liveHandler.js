import { Recording } from '../models/Recording.js';
import { TranscriptSegment } from '../models/TranscriptSegment.js';
import { logger } from '../lib/logger.js';
import { speakerLabel } from '../lib/text.js';
import { createAppendStream, ensureDirFor, resolvePath, stat } from '../storage/index.js';
import { stt } from '../ai/stt/index.js';


const sessions = new Map();
const state = new Map();

const FLUSH_MS = 1500;
const HEARTBEAT_MS = 30_000;
// live diarization needs time to learn the voices; at these points (seconds of audio) the audio so far is
// re-transcribed as a whole and the live transcript is corrected if that finds more speakers
const SPEAKER_REFRESH_AT = [6, 12, 20, 30, 45, 60, 80, 105, 135, 170, 210, 260, 320, 400];
// lines older than this (relative to the audio a refresh covered) are no longer relabelled
const SETTLE_AFTER_SEC = 15;

const toClient = (d) => ({ id: `live-${d.idx}`, speaker: d.speaker, text: d.text, start: d.start, end: d.end, isFinal: true });

// which corrected speaker each live label mostly overlaps with
function mapSpeakers(liveSegs, fixedSegs) {
  const votes = new Map();
  for (const l of liveSegs) {
    for (const f of fixedSegs) {
      const overlap = Math.min(l.end, f.end) - Math.max(l.start, f.start);
      if (overlap <= 0) continue;
      const v = votes.get(l.speaker) ?? new Map();
      v.set(f.speaker, (v.get(f.speaker) ?? 0) + overlap);
      votes.set(l.speaker, v);
    }
  }
  const map = new Map();
  for (const [label, v] of votes) map.set(label, [...v.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return map;
}

// rename a refresh's speakers to the labels already on screen, so nobody's label flips between refreshes;
// a voice with no match on screen gets the next free letter
function alignToScreen(fixed, onScreen) {
  const overlap = new Map();
  for (const f of fixed) {
    for (const c of onScreen) {
      const o = Math.min(f.end, c.end) - Math.max(f.start, c.start);
      if (o > 0) overlap.set(`${f.speaker}\n${c.speaker}`, (overlap.get(`${f.speaker}\n${c.speaker}`) ?? 0) + o);
    }
  }
  const rename = new Map();
  const taken = new Set();
  for (const [key] of [...overlap.entries()].sort((a, b) => b[1] - a[1])) {
    const [from, to] = key.split('\n');
    if (rename.has(from) || taken.has(to)) continue;
    rename.set(from, to);
    taken.add(to);
  }
  const inUse = new Set([...onScreen.map((c) => c.speaker), ...taken]);
  let next = 0;
  for (const f of fixed) {
    if (rename.has(f.speaker)) continue;
    while (inUse.has(speakerLabel(next))) next++;
    rename.set(f.speaker, speakerLabel(next));
    inUse.add(speakerLabel(next));
  }
  return fixed.map((f) => ({ ...f, speaker: rename.get(f.speaker) }));
}

export function closeLiveSession(recordingId) {
  sessions.get(String(recordingId))?.ws.close(4410, 'Recording closed');
}

export async function handleLiveConnection(ws, { user, recordingId, timeOffsetSec = 0 }) {
  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const rec = await Recording.findOne({ _id: recordingId, user: user.id }).catch(() => null);
  if (!rec) return ws.close(4404, 'Recording not found');
  if (rec.status !== 'recording') return ws.close(4409, 'Recording is no longer active');

  const prev = sessions.get(recordingId);
  if (prev) {
    prev.ws.terminate();
    await Promise.race([prev.closed, new Promise((r) => setTimeout(r, 3000))]);
  }
  let markClosed;
  sessions.set(recordingId, { ws, closed: new Promise((r) => (markClosed = r)) });

  let s = state.get(recordingId);
  if (!s) {
    const existing = await stat(rec.audio.key);
    const lastSeg = await TranscriptSegment.findOne({ recording: rec._id, kind: 'live' }).sort({ idx: -1 }).select('idx').lean();
    s = {
      expectedSeq: rec.liveChunks ?? 0,
      gap: Boolean(rec.audioGap) || (!existing && (rec.liveChunks ?? 0) > 0),
      bytes: existing?.size ?? 0,
      idx: lastSeg ? lastSeg.idx + 1 : 0,
      refreshStep: 0,
      refreshing: false,
      settledUntil: 0,
    };
    state.set(recordingId, s);
  }
  // a new Deepgram stream starts with its own speaker numbering
  s.speakerMap = new Map();

  await ensureDirFor(rec.audio.key);
  const file = createAppendStream(rec.audio.key);
  file.on('close', () => markClosed());
  file.on('error', (err) => {
    logger.error('Live audio write failed', { recording: recordingId, error: err.message });
    s.gap = true;
  });

  let stopped = false;
  let sttFailed = false;
  let pendingFinals = [];
  let chunksSinceAck = 0;
  const rawFinals = []; // finals of this Deepgram stream with its own speaker labels

  const flushFinals = async () => {
    if (!pendingFinals.length) return;
    const docs = pendingFinals;
    pendingFinals = [];
    await TranscriptSegment.insertMany(docs, { ordered: false }).catch((err) =>
      logger.warn('Failed to persist live segments', { recording: recordingId, error: err.message })
    );
  };

  // relabel live lines with the speakers a whole-file pass hears; the live text itself is kept
  async function refreshSpeakers() {
    s.refreshing = true;
    s.refreshStep += 1;
    try {
      const result = await stt.transcribeFile({ filePath: resolvePath(rec.audio.key), mimeType: rec.audio.mimeType });
      const speakers = new Set(result.segments.map((f) => f.speaker)).size;
      logger.info('Live speaker refresh', { recording: recordingId, audioSec: Math.round(result.durationSec ?? 0), speakers });
      if (stopped || speakers < 2) return;

      await flushFinals();
      // the end of a file that is still being written is unreliable
      const reliableEnd = (result.durationSec ?? result.segments[result.segments.length - 1].end) - 2;
      const liveSegs = await TranscriptSegment.find({ recording: rec._id, kind: 'live', end: { $lte: reliableEnd } }).lean();
      const fixed = alignToScreen(result.segments, liveSegs);
      for (const [from, to] of mapSpeakers(rawFinals, fixed)) s.speakerMap.set(from, to);
      const updates = [];
      // lines an earlier refresh already settled stay as they are, so the screen doesn't keep changing
      for (const l of liveSegs.filter((x) => x.start >= s.settledUntil)) {
        const best = mapSpeakers([{ ...l, speaker: 'line' }], fixed).get('line');
        if (best && best !== l.speaker) updates.push({ updateOne: { filter: { _id: l._id }, update: { $set: { speaker: best } } } });
      }
      if (stopped) return;
      if (updates.length) await TranscriptSegment.bulkWrite(updates);
      s.settledUntil = Math.max(s.settledUntil, reliableEnd - SETTLE_AFTER_SEC);
      await flushFinals();
      const all = await TranscriptSegment.find({ recording: rec._id, kind: 'live' }).sort({ start: 1, idx: 1 }).lean();
      send({ type: 'live_reset', segments: all.map(toClient) });
    } catch (err) {
      logger.warn('Live speaker refresh failed', { recording: recordingId, error: err.message });
    } finally {
      s.refreshing = false;
    }
  }

  const live = stt.createLiveSession({
    timeOffsetSec,
    onTranscript(seg) {
      if (seg.isFinal) rawFinals.push({ speaker: seg.speaker, start: seg.start, end: seg.end });
      seg = { ...seg, speaker: s.speakerMap.get(seg.speaker) ?? seg.speaker };
      if (seg.isFinal) {
        if (!s.refreshing && seg.end >= SPEAKER_REFRESH_AT[s.refreshStep]) refreshSpeakers();
        const doc = { recording: rec._id, kind: 'live', idx: s.idx++, speaker: seg.speaker, start: seg.start, end: seg.end, text: seg.text, confidence: seg.confidence };
        pendingFinals.push(doc);
        send({ type: 'transcript', segment: toClient(doc) });
      } else {
        send({ type: 'transcript', segment: { speaker: seg.speaker, text: seg.text, start: seg.start, isFinal: false } });
      }
    },
    onError(err) {
      if (sttFailed) return;
      sttFailed = true;
      logger.warn('Live STT error', { recording: recordingId, error: err.message });
      send({ type: 'stt_error', message: `${err.message} Your audio is still being recorded and will be fully transcribed when you stop.` });
    },
  });

  const flushTimer = setInterval(flushFinals, FLUSH_MS);
  const keepAliveTimer = setInterval(() => live.keepAlive(), 3000);
  const heartbeatTimer = setInterval(() => {
    Recording.updateOne({ _id: rec._id }, { lastActivityAt: new Date(), liveChunks: s.expectedSeq, audioGap: s.gap }).catch(() => {});
  }, HEARTBEAT_MS);

  const persistProgress = () =>
    Recording.updateOne(
      { _id: rec._id },
      { liveChunks: s.expectedSeq, audioGap: s.gap, lastActivityAt: new Date(), 'audio.size': s.bytes }
    );

  const cleanup = () => {
    clearInterval(flushTimer);
    clearInterval(keepAliveTimer);
    clearInterval(heartbeatTimer);
    if (sessions.get(recordingId)?.ws === ws) sessions.delete(recordingId);
  };

  async function stop(totalChunks) {
    if (stopped) return;
    stopped = true;
    await live.finish();
    await flushFinals();
    await new Promise((resolve) => file.end(resolve));
    await persistProgress();
    const complete = !s.gap && s.expectedSeq === totalChunks && s.bytes > 0;
    send({ type: 'stopped', receivedChunks: s.expectedSeq, complete });
    state.delete(recordingId);
    cleanup();
    ws.close(1000, 'Stopped');
  }

  ws.on('message', (data, isBinary) => {
    if (stopped) return;
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 6) return;
      const isReplay = (buf[0] & 1) === 1;
      const seq = buf.readUInt32BE(1);
      const payload = buf.subarray(5);
      if (!isReplay) {
        if (seq === s.expectedSeq && !s.gap) {
          file.write(payload);
          s.bytes += payload.length;
          s.expectedSeq += 1;
        } else if (seq >= s.expectedSeq) {
          s.gap = true;
          s.expectedSeq = seq + 1;
        }
        if (++chunksSinceAck >= 8) {
          chunksSinceAck = 0;
          send({ type: 'ack', seq: s.expectedSeq - 1, bytes: s.bytes });
        }
      }
      if (!sttFailed) live.send(payload);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'activity') live.setActivity(msg.speaking, Number(msg.t));
    else if (msg.type === 'stop') stop(Number(msg.totalChunks) || 0).catch((err) => logger.error('Live stop failed', { error: err.message }));
  });

  ws.on('close', () => {
    if (stopped) return;
    cleanup();
    live.close();
    flushFinals();
    file.end();
    persistProgress().catch(() => {});
  });

  send({ type: 'ready', resumeFromSeq: s.expectedSeq, provider: live.provider });
}
