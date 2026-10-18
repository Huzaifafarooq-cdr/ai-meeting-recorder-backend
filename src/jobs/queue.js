import os from 'node:os';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { Job } from '../models/Job.js';
import { Recording } from '../models/Recording.js';
import { logger } from '../lib/logger.js';
import { emitRecordingUpdate } from '../realtime/eventBus.js';
import { dropLocalCopy, persist, stat } from '../storage/index.js';
import { runPipeline } from './pipeline.js';

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const LEASE_MS = 5 * 60 * 1000;
const POLL_MS = 2000;
const NON_RETRYABLE_MANUALLY = new Set(['AUDIO_EMPTY', 'AUDIO_MISSING']);

let running = false;
let active = 0;
let claiming = false;
let pollTimer = null;
const inFlight = new Set();

export async function enqueueProcessing(rec, { fromStage = 'upload' } = {}) {
  if (rec.audio?.key && (await stat(rec.audio.key))) {
    try {
      await persist(rec.audio.key, rec.audio.mimeType);
      if (!env.RUN_WORKER) await dropLocalCopy(rec.audio.key);
    } catch (err) {
      logger.warn('Could not copy audio to storage yet, the worker will retry', { recording: rec.id, error: err.message });
    }
  }
  await Job.updateMany({ recording: rec._id, status: 'queued' }, { $set: { status: 'cancelled' } });
  await Job.create({ recording: rec._id, user: rec.user, fromStage, maxAttempts: env.JOB_MAX_ATTEMPTS });
  rec.status = 'queued';
  rec.stage = fromStage;
  rec.error = undefined;
  rec.retryInfo = undefined;
  await rec.save();
  emitRecordingUpdate(rec);
  setImmediate(tick);
}

async function claimJob() {
  const now = new Date();
  return Job.findOneAndUpdate(
    {
      $or: [
        { status: 'queued', runAt: { $lte: now } },
        { status: 'running', lockedUntil: { $lt: now } },
      ],
    },
    { $set: { status: 'running', lockedBy: WORKER_ID, lockedUntil: new Date(Date.now() + LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true }
  );
}

async function handleFailure(job, err) {
  const rec = await Recording.findById(job.recording);
  if (!rec) return Job.updateOne({ _id: job._id }, { status: 'cancelled' });

  const retryable = err.retryable !== false;
  const stage = err.stage ?? job.fromStage;
  const lastError = { code: err.code ?? 'PROCESSING_ERROR', message: err.message };

  if (retryable && job.attempts < job.maxAttempts) {
    const base = lastError.code === 'AI_RATE_LIMITED' ? 30_000 : 5000;
    const delay = Math.max(err.retryAfterMs ?? 0, base * 2 ** (job.attempts - 1));
    const nextRunAt = new Date(Date.now() + delay);
    await Job.updateOne({ _id: job._id }, { status: 'queued', runAt: nextRunAt, fromStage: stage, lastError, lockedUntil: null });
    rec.status = 'queued';
    rec.stage = stage;
    rec.retryInfo = { attempt: job.attempts + 1, maxAttempts: job.maxAttempts, nextRunAt, message: err.message };
    await rec.save();
    emitRecordingUpdate(rec);
    logger.warn('Job failed, retry scheduled', { job: job.id, stage, attempt: job.attempts, delayMs: delay, error: err.message });
    return;
  }

  await Job.updateOne({ _id: job._id }, { status: 'failed', lastError, lockedUntil: null });
  rec.status = 'failed';
  rec.stage = stage;
  rec.retryInfo = undefined;
  rec.error = { code: lastError.code, message: err.message, stage, retryable: !NON_RETRYABLE_MANUALLY.has(lastError.code) };
  await rec.save();
  emitRecordingUpdate(rec);
  logger.error('Job failed permanently', { job: job.id, stage, error: err.message, cause: err.cause?.message });
}

async function execute(job) {
  const heartbeat = setInterval(() => {
    Job.updateOne({ _id: job._id, lockedBy: WORKER_ID }, { lockedUntil: new Date(Date.now() + LEASE_MS) }).catch(() => {});
  }, LEASE_MS / 3);
  try {
    await runPipeline(job.recording, job.fromStage);
    await Job.updateOne({ _id: job._id }, { status: 'done', lockedUntil: null });
  } catch (err) {
    if (err instanceof mongoose.Error.DocumentNotFoundError) {
      await Job.updateOne({ _id: job._id }, { status: 'cancelled' });
    } else {
      await handleFailure(job, err).catch((e) => logger.error('Failed to record job failure', { error: e.message }));
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function tick() {
  if (!running || claiming) return;
  claiming = true;
  try {
    while (running && active < env.WORKER_CONCURRENCY) {
      let job;
      try {
        job = await claimJob();
      } catch (err) {
        logger.error('Could not claim job', { error: err.message });
        return;
      }
      if (!job) return;
      active += 1;
      inFlight.add(job._id);
      logger.info('Processing recording', { job: job.id, recording: job.recording.toString(), from: job.fromStage, attempt: job.attempts });
      execute(job).finally(() => {
        active -= 1;
        inFlight.delete(job._id);
        setImmediate(tick);
      });
    }
  } finally {
    claiming = false;
  }
}

export function startWorker() {
  if (running) return;
  running = true;
  pollTimer = setInterval(tick, POLL_MS);
  setImmediate(tick);
  logger.info('Background worker started', { id: WORKER_ID, concurrency: env.WORKER_CONCURRENCY });
}

export async function stopWorker() {
  running = false;
  clearInterval(pollTimer);
  const deadline = Date.now() + 10_000;
  while (active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (inFlight.size) {
    await Job.updateMany(
      { _id: { $in: [...inFlight] }, lockedBy: WORKER_ID, status: 'running' },
      { $set: { status: 'queued', runAt: new Date(), lockedUntil: null }, $inc: { attempts: -1 } }
    ).catch((err) => logger.error('Could not release jobs on shutdown', { error: err.message }));
    logger.warn('Released unfinished jobs on shutdown', { count: inFlight.size });
  }
}
