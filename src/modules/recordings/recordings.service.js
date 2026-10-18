import fsp from 'node:fs/promises';
import mongoose from 'mongoose';
import { Recording } from '../../models/Recording.js';
import { TranscriptSegment } from '../../models/TranscriptSegment.js';
import { Job } from '../../models/Job.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/AppError.js';
import { audioExists, audioKey, moveInto, remove, stat } from '../../storage/index.js';
import { enqueueProcessing } from '../../jobs/queue.js';
import { recoverRecording } from '../../jobs/sweeper.js';
import { emitRecordingDeleted, emitRecordingUpdate } from '../../realtime/eventBus.js';
import { closeLiveSession } from '../../realtime/liveHandler.js';
import { audioMimeFor } from '../../middleware/upload.js';
import { probeDuration } from '../../lib/audio.js';
import { toDetail, toSummary } from './recordings.serializer.js';

const DEFAULT_TITLE = 'New meeting';
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function findOwned(userId, id, projection) {
  const query = Recording.findOne({ _id: id, user: userId });
  if (projection) query.select(projection);
  const rec = await query;
  if (!rec) throw notFound('Recording');
  return rec;
}

function titleFromFilename(name = '') {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return base ? base.slice(0, 120) : DEFAULT_TITLE;
}

export async function createLive(userId, { title, mimeType }) {
  const rec = new Recording({
    user: userId,
    source: 'live',
    status: 'recording',
    title: title || DEFAULT_TITLE,
    titleSource: title ? 'user' : 'auto',
    lastActivityAt: new Date(),
  });
  rec.audio = { key: audioKey(userId, rec._id, mimeType), mimeType: mimeType.split(';')[0] };
  await rec.save();
  emitRecordingUpdate(rec);
  return toDetail(rec);
}

export async function createFromUpload(userId, file, { title, durationSec }) {
  if (!file) throw badRequest('NO_FILE', 'Please choose an audio file to upload.');
  const mimeType = audioMimeFor(file);
  const rec = new Recording({
    user: userId,
    source: 'upload',
    status: 'queued',
    title: title || titleFromFilename(file.originalname),
    titleSource: title ? 'user' : 'auto',
    durationSec: Math.round(durationSec || (await probeDuration(file.path, mimeType))),
  });
  rec.audio = { key: audioKey(userId, rec._id, mimeType), mimeType, size: file.size, originalName: file.originalname?.slice(0, 200) };
  try {
    await moveInto(file.path, rec.audio.key);
    await rec.save();
  } catch (err) {
    await fsp.rm(file.path, { force: true });
    throw err;
  }
  await enqueueProcessing(rec);
  return toDetail(rec);
}

export async function finalize(userId, id, { durationSec, totalChunks }) {
  const rec = await findOwned(userId, id);
  if (rec.status !== 'recording') throw conflict('ALREADY_FINALIZED', 'This recording has already been submitted for processing.');
  rec.durationSec = Math.round(durationSec);
  const file = await stat(rec.audio?.key);
  const complete = !rec.audioGap && rec.liveChunks === totalChunks && file?.size > 0;
  if (!complete) {
    await rec.save();
    throw new AppError(409, 'AUDIO_INCOMPLETE', 'Some audio did not reach the server while recording. Uploading the full recording from your browser instead.', {
      details: { receivedChunks: rec.liveChunks, totalChunks },
    });
  }
  await enqueueProcessing(rec);
  return toDetail(rec);
}

export async function recover(userId, id) {
  const rec = await findOwned(userId, id);
  if (rec.status !== 'recording') return toDetail(rec);
  closeLiveSession(id);
  await new Promise((r) => setTimeout(r, 500));
  await recoverRecording(rec);
  return toDetail(rec);
}

export async function replaceAudio(userId, id, file, { durationSec }) {
  if (!file) throw badRequest('NO_FILE', 'No audio file received.');
  let rec;
  try {
    rec = await findOwned(userId, id);
    if (!['recording', 'failed'].includes(rec.status)) {
      throw conflict('INVALID_STATE', 'Audio can only be replaced while recording or after a failure.');
    }
  } catch (err) {
    await fsp.rm(file.path, { force: true });
    throw err;
  }
  closeLiveSession(id);
  const mimeType = audioMimeFor(file);
  durationSec ||= rec.durationSec || (await probeDuration(file.path, mimeType));
  const key = audioKey(userId, rec._id, mimeType);
  if (rec.audio?.key && rec.audio.key !== key) await remove(rec.audio.key);
  await remove(key);
  await moveInto(file.path, key);
  rec.audio = { key, mimeType, size: file.size, originalName: rec.audio?.originalName };
  rec.audioGap = false;
  if (durationSec) rec.durationSec = Math.round(durationSec);
  await enqueueProcessing(rec);
  return toDetail(rec);
}

function snippetFrom(text, terms) {
  if (!text) return null;
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    for (const probe of [t, t.slice(0, 5)]) {
      const i = probe.length >= 3 ? lower.indexOf(probe) : -1;
      if (i !== -1 && (pos === -1 || i < pos)) pos = i;
    }
  }
  if (pos === -1) return null;
  const start = Math.max(0, pos - 70);
  const end = Math.min(text.length, pos + 130);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

export async function list(userId, { q, from, to, status, page, limit }) {
  const base = { user: new mongoose.Types.ObjectId(userId) };
  if (from || to) base.createdAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (status) base.status = status === 'in_progress' ? { $in: ['queued', 'processing'] } : status;

  const skip = (page - 1) * limit;
  const listProjection = '-stages.error';

  if (!q) {
    const [items, total] = await Promise.all([
      Recording.find(base).select(listProjection).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Recording.countDocuments(base),
    ]);
    return { items: items.map(toSummary), total, page, limit };
  }

  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  let filter = { ...base, $text: { $search: q } };
  let [items, total] = await Promise.all([
    Recording.find(filter, { score: { $meta: 'textScore' } })
      .select('+transcriptText')
      .sort({ score: { $meta: 'textScore' }, createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Recording.countDocuments(filter),
  ]);
  if (total === 0) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter = { ...base, $or: [{ title: rx }, { keywords: rx }, { 'summary.overview': rx }, { transcriptText: rx }] };
    [items, total] = await Promise.all([
      Recording.find(filter).select('+transcriptText').sort({ createdAt: -1 }).skip(skip).limit(limit),
      Recording.countDocuments(filter),
    ]);
  }

  return {
    items: items.map((rec) => {
      const fields = [
        ['title', rec.title],
        ['keywords', rec.keywords?.join(', ')],
        ['summary', rec.summary?.overview],
        ['transcript', rec.transcriptText],
      ];
      const hit = fields.map(([field, text]) => ({ field, snippet: snippetFrom(text, terms) })).find((h) => h.snippet);
      return { ...toSummary(rec), match: hit ?? null };
    }),
    total,
    page,
    limit,
  };
}

export async function stats(userId) {
  const [byStatus] = await Recording.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        totalDurationSec: { $sum: '$durationSec' },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        processing: { $sum: { $cond: [{ $in: ['$status', ['queued', 'processing']] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        actionItems: { $sum: { $size: { $ifNull: ['$actionItems', []] } } },
      },
    },
  ]);
  return byStatus ?? { total: 0, totalDurationSec: 0, completed: 0, processing: 0, failed: 0, actionItems: 0 };
}

export async function getDetail(userId, id) {
  return toDetail(await findOwned(userId, id));
}

export async function getTranscript(userId, id, kind) {
  const rec = await findOwned(userId, id, '_id speakers');
  const segments = await TranscriptSegment.find({ recording: rec._id, kind })
    .sort(kind === 'live' ? { start: 1, idx: 1 } : { idx: 1 })
    .select('-_id idx speaker start end text cleanText confidence')
    .lean();
  return { kind, segments };
}

export async function getAudioInfo(userId, id) {
  const rec = await findOwned(userId, id, 'audio user');
  if (!rec.audio?.key || !(await audioExists(rec.audio.key))) throw notFound('Audio for this recording');
  return rec;
}

export async function update(userId, id, { title }) {
  const rec = await Recording.findOneAndUpdate({ _id: id, user: userId }, { $set: { title, titleSource: 'user' } }, { new: true });
  if (!rec) throw notFound('Recording');
  emitRecordingUpdate(rec);
  return toDetail(rec);
}

export async function renameSpeakers(userId, id, speakers) {
  const rec = await findOwned(userId, id);
  const names = new Map(speakers.map((s) => [s.label, s.name.trim()]));
  rec.speakers = (rec.speakers ?? []).map((s) => ({ label: s.label, name: names.has(s.label) ? names.get(s.label) : s.name }));
  await rec.save();
  emitRecordingUpdate(rec);
  return toDetail(rec);
}

export async function setActionItemDone(userId, id, index, done) {
  const rec = await findOwned(userId, id);
  const item = rec.actionItems?.[index];
  if (!item) throw notFound('Action item');
  item.done = done;
  await rec.save();
  emitRecordingUpdate(rec);
  return toDetail(rec);
}

export async function retry(userId, id) {
  const rec = await findOwned(userId, id);
  if (rec.status !== 'failed') throw conflict('INVALID_STATE', 'Only failed recordings can be retried.');
  if (rec.error && rec.error.retryable === false) {
    throw conflict('NOT_RETRYABLE', 'This recording cannot be reprocessed because its audio is missing or empty. Please upload the audio again.');
  }
  await enqueueProcessing(rec, { fromStage: rec.error?.stage ?? 'upload' });
  return toDetail(rec);
}

export async function removeRecording(userId, id) {
  const rec = await findOwned(userId, id);
  closeLiveSession(id);
  await Promise.all([
    TranscriptSegment.deleteMany({ recording: rec._id }),
    Job.updateMany({ recording: rec._id, status: { $in: ['queued', 'running'] } }, { status: 'cancelled' }),
    remove(rec.audio?.key),
  ]);
  await rec.deleteOne();
  emitRecordingDeleted(userId, rec._id);
}
