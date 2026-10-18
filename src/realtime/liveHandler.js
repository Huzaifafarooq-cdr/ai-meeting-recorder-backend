import { Recording } from '../models/Recording.js';
import { TranscriptSegment } from '../models/TranscriptSegment.js';
import { logger } from '../lib/logger.js';
import { createAppendStream, ensureDirFor, stat } from '../storage/index.js';
import { stt } from '../ai/stt/index.js';


const sessions = new Map();
const state = new Map();

const FLUSH_MS = 1500;
const HEARTBEAT_MS = 30_000;

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
    s = {
      expectedSeq: rec.liveChunks ?? 0,
      gap: Boolean(rec.audioGap) || (!existing && (rec.liveChunks ?? 0) > 0),
      bytes: existing?.size ?? 0,
      idx: await TranscriptSegment.countDocuments({ recording: rec._id, kind: 'live' }),
    };
    state.set(recordingId, s);
  }

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

  const flushFinals = async () => {
    if (!pendingFinals.length) return;
    const docs = pendingFinals;
    pendingFinals = [];
    await TranscriptSegment.insertMany(docs, { ordered: false }).catch((err) =>
      logger.warn('Failed to persist live segments', { recording: recordingId, error: err.message })
    );
  };

  const live = stt.createLiveSession({
    timeOffsetSec,
    onTranscript(seg) {
      if (seg.isFinal) {
        const doc = { recording: rec._id, kind: 'live', idx: s.idx++, speaker: seg.speaker, start: seg.start, end: seg.end, text: seg.text, confidence: seg.confidence };
        pendingFinals.push(doc);
        send({ type: 'transcript', segment: { id: `live-${doc.idx}`, speaker: doc.speaker, text: doc.text, start: doc.start, end: doc.end, isFinal: true } });
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
