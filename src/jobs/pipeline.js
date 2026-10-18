import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { Recording, STAGES } from '../models/Recording.js';
import { TranscriptSegment } from '../models/TranscriptSegment.js';
import { AppError } from '../lib/AppError.js';
import { logger } from '../lib/logger.js';
import { mapLimit } from '../lib/concurrency.js';
import { cleanSentence, wordCount } from '../lib/text.js';
import { emitRecordingUpdate } from '../realtime/eventBus.js';
import { dropLocalCopy, persist, resolvePath, restoreLocal, stat } from '../storage/index.js';
import { stt } from '../ai/stt/index.js';
import { llm } from '../ai/llm/index.js';

const CLEAN_BATCH = 40;
const LOW_CONFIDENCE = 0.6;
const MIN_AUDIO_BYTES = 1024;
// independent of each other, run in parallel
const ANALYSIS = new Set(['summary', 'action_items', 'insights']);

const stageOf = (rec, key) => rec.stages.find((s) => s.key === key);

function markStage(rec, key, status, error) {
  const stage = stageOf(rec, key);
  stage.status = status;
  if (status === 'running') {
    stage.startedAt = new Date();
    stage.finishedAt = undefined;
    stage.error = undefined;
    rec.stage = key;
  } else {
    stage.finishedAt = new Date();
    if (error) stage.error = error;
  }
}

async function setStage(rec, key, status, error) {
  markStage(rec, key, status, error);
  await rec.save();
  emitRecordingUpdate(rec);
}

function stageError(err, key) {
  const error = err instanceof AppError ? err : new AppError(500, 'PROCESSING_ERROR', `Unexpected error during ${key}.`, { retryable: true, cause: err });
  error.stage = key;
  return error;
}

const loadSegments = (rec, kind = 'final') => TranscriptSegment.find({ recording: rec._id, kind }).sort({ idx: 1 }).lean();

async function replaceFinalSegments(rec, segments) {
  await TranscriptSegment.deleteMany({ recording: rec._id, kind: 'final' });
  if (segments.length) {
    await TranscriptSegment.insertMany(
      segments.map((s, idx) => ({ ...s, recording: rec._id, kind: 'final', idx })),
      { ordered: false }
    );
  }
}

const buildTranscript = (segments) =>
  segments
    .map((s) => ({ speaker: s.speaker, text: (s.cleanText ?? s.text ?? '').trim() }))
    .filter((s) => s.text)
    .map((s) => `${s.speaker}: ${s.text}`)
    .join('\n');

const handlers = {
  async upload(ctx) {
    const { rec } = ctx;
    const file = await stat(rec.audio?.key);
    if (!file) throw new AppError(422, 'AUDIO_MISSING', 'The audio file for this recording could not be found. Please upload it again.');
    if (file.size < MIN_AUDIO_BYTES) {
      throw new AppError(422, 'AUDIO_EMPTY', 'The recording contains no usable audio. It may have been interrupted before any sound was captured.');
    }
    rec.audio.size = file.size;
    await persist(rec.audio.key, rec.audio.mimeType).catch((err) => {
      throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Could not save the audio to storage.', { retryable: true, cause: err });
    });
  },

  async transcription(ctx) {
    const { rec } = ctx;
    const liveSegments = rec.source === 'live' ? await loadSegments(rec, 'live') : [];
    const result = await stt.transcribeFile({
      filePath: resolvePath(rec.audio.key),
      mimeType: rec.audio.mimeType,
      durationSec: rec.durationSec,
      source: rec.source,
      liveSegments,
    });
    if (result.durationSec) rec.durationSec = Math.round(result.durationSec);
    rec.language = result.language;

    const segments = result.segments.filter((s) => s.text?.trim());
    await replaceFinalSegments(rec, segments);
    if (!segments.length) {
      rec.addWarning('NO_SPEECH', 'No speech was detected. The recording may be silent, or the microphone volume was too low.');
      ctx.stopEarly = true;
      return;
    }
    const avg = segments.reduce((sum, s) => sum + (s.confidence ?? 1), 0) / segments.length;
    if (avg < LOW_CONFIDENCE) {
      rec.addWarning('LOW_CONFIDENCE', 'Audio quality looks poor (background noise or low volume), so the transcript may contain mistakes.');
    }
    rec.set('stats.avgConfidence', Number(avg.toFixed(3)));
  },

  async diarization(ctx) {
    const { rec } = ctx;
    const segments = await loadSegments(rec);
    // merge consecutive segments from the same speaker
    const merged = [];
    for (const s of segments) {
      const last = merged[merged.length - 1];
      if (last && last.speaker === s.speaker && s.start - last.end < 2 && last.text.length + s.text.length < 700) {
        last.text = `${last.text} ${s.text}`;
        last.end = s.end;
        last.confidence = ((last.confidence ?? 1) + (s.confidence ?? 1)) / 2;
      } else {
        merged.push({ speaker: s.speaker, start: s.start, end: s.end, text: s.text, confidence: s.confidence });
      }
    }
    await replaceFinalSegments(rec, merged);
    const labels = [...new Set(merged.map((s) => s.speaker))];
    const existing = new Map((rec.speakers ?? []).map((s) => [s.label, s.name]));
    rec.speakers = labels.map((label) => ({ label, name: existing.get(label) ?? '' }));
    rec.set('stats.segmentCount', merged.length);
    rec.set('stats.speakerCount', labels.length);
  },

  async transcript(ctx) {
    const { rec } = ctx;
    const segments = await loadSegments(rec);
    const batches = [];
    for (let i = 0; i < segments.length; i += CLEAN_BATCH) batches.push(segments.slice(i, i + CLEAN_BATCH));
    let failedBatches = 0;
    await mapLimit(batches, env.LLM_CONCURRENCY, async (batch) => {
      let cleaned = {};
      try {
        cleaned = await llm.cleanSegments(batch.map((s) => ({ id: String(s.idx), speaker: s.speaker, text: s.text })));
      } catch (err) {
        // fall back to basic cleanup if the llm fails
        failedBatches += 1;
        logger.warn('Transcript cleanup batch failed, using fallback', { recording: rec.id, error: err.message });
      }
      for (const s of batch) s.cleanText = cleaned[String(s.idx)] ?? cleanSentence(s.text);
    });
    const ops = segments.map((s) => ({ updateOne: { filter: { _id: s._id }, update: { $set: { cleanText: s.cleanText } } } }));
    if (ops.length) await TranscriptSegment.bulkWrite(ops, { ordered: false });
    if (failedBatches) {
      rec.addWarning('PARTIAL_CLEANUP', `AI cleanup failed for part of the transcript (${failedBatches} section${failedBatches > 1 ? 's' : ''}); basic formatting was applied instead.`);
    }
    rec.transcriptText = buildTranscript(segments);
    rec.set('stats.wordCount', wordCount(rec.transcriptText));
  },

  // return an apply fn instead of mutating rec directly (these run concurrently)
  async summary(ctx) {
    const summary = await llm.summarize(await transcriptFor(ctx));
    return (rec) => {
      rec.summary = summary;
    };
  },

  async action_items(ctx) {
    const { actionItems, keyDecisions } = await llm.extractActions(await transcriptFor(ctx));
    return (rec) => {
      rec.actionItems = actionItems;
      rec.keyDecisions = keyDecisions;
    };
  },

  async insights(ctx) {
    const { title, keywords } = await llm.generateInsights(await transcriptFor(ctx));
    return (rec) => {
      rec.keywords = keywords;
      if (title && rec.titleSource !== 'user') rec.title = title;
    };
  },
};

function transcriptFor(ctx) {
  ctx.transcript ??= (async () => {
    if (ctx.rec.transcriptText) return ctx.rec.transcriptText;
    const text = buildTranscript(await loadSegments(ctx.rec));
    if (!text) throw new AppError(422, 'NO_TRANSCRIPT', 'There is no transcript to analyse.');
    return text;
  })();
  return ctx.transcript;
}

async function runAnalysis(ctx, keys) {
  const { rec } = ctx;
  // mongoose doesn't allow parallel save() on the same doc, so queue them
  let chain = Promise.resolve();
  const commit = (mutate) =>
    (chain = chain.then(async () => {
      mutate();
      await rec.save();
      emitRecordingUpdate(rec);
    }));

  await commit(() => keys.forEach((key) => markStage(rec, key, 'running')));
  const results = await Promise.allSettled(
    keys.map(async (key) => {
      let apply;
      try {
        apply = await handlers[key](ctx);
      } catch (err) {
        const error = stageError(err, key);
        await commit(() => markStage(rec, key, 'failed', error.message));
        throw error;
      }
      await commit(() => {
        apply(rec);
        markStage(rec, key, 'done');
      });
    })
  );
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  if (errors.length) throw errors.find((e) => e instanceof mongoose.Error.DocumentNotFoundError) ?? errors[0];
}

export async function runPipeline(recordingId, fromStage = 'upload') {
  const rec = await Recording.findById(recordingId).select('+transcriptText');
  if (!rec) return { skipped: true };
  await restoreLocal(rec.audio?.key);
  try {
    return await runStages(rec, fromStage);
  } finally {
    await dropLocalCopy(rec.audio?.key).catch(() => {});
  }
}

async function runStages(rec, fromStage) {
  const startIdx = Math.max(0, STAGES.indexOf(fromStage));
  // keep other analysis results on retry
  const keepDone = (key) => ANALYSIS.has(fromStage) && ANALYSIS.has(key) && key !== fromStage && stageOf(rec, key).status === 'done';
  rec.status = 'processing';
  rec.error = undefined;
  for (const s of rec.stages.slice(startIdx)) {
    if (keepDone(s.key)) continue;
    s.status = 'pending';
    s.error = undefined;
  }
  await rec.save();
  emitRecordingUpdate(rec);

  const ctx = { rec, stopEarly: false };
  const keys = STAGES.slice(startIdx).filter((key) => !keepDone(key));
  for (const key of keys.filter((k) => !ANALYSIS.has(k))) {
    if (ctx.stopEarly) {
      await setStage(rec, key, 'skipped');
      continue;
    }
    await setStage(rec, key, 'running');
    try {
      await handlers[key](ctx);
    } catch (err) {
      const error = stageError(err, key);
      await setStage(rec, key, 'failed', error.message);
      throw error;
    }
    await setStage(rec, key, 'done');
  }

  const analysis = keys.filter((k) => ANALYSIS.has(k));
  if (analysis.length) {
    if (ctx.stopEarly) {
      analysis.forEach((key) => markStage(rec, key, 'skipped'));
      await rec.save();
      emitRecordingUpdate(rec);
    } else {
      await runAnalysis(ctx, analysis);
    }
  }

  rec.status = 'completed';
  rec.stage = 'completed';
  rec.retryInfo = undefined;
  rec.completedAt = new Date();
  await rec.save();
  emitRecordingUpdate(rec);
  return { completed: true };
}
