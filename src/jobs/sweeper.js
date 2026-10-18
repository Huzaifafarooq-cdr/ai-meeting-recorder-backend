import { Recording } from '../models/Recording.js';
import { logger } from '../lib/logger.js';
import { stat } from '../storage/index.js';
import { emitRecordingUpdate } from '../realtime/eventBus.js';
import { enqueueProcessing } from './queue.js';

const STALE_MS = 30 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

// process interrupted live recordings with whatever audio we got
export async function sweepAbandonedRecordings() {
  const cutoff = new Date(Date.now() - STALE_MS);
  const stale = await Recording.find({
    status: 'recording',
    $or: [{ lastActivityAt: { $lt: cutoff } }, { lastActivityAt: null, createdAt: { $lt: cutoff } }],
  }).limit(50);

  for (const rec of stale) {
    const file = await stat(rec.audio?.key);
    if (file && file.size > 1024) {
      rec.addWarning('INTERRUPTED', 'This recording was interrupted (connection lost or browser closed). The audio captured before the interruption was processed.');
      await enqueueProcessing(rec);
      logger.info('Recovered interrupted recording', { recording: rec.id });
    } else {
      rec.status = 'failed';
      rec.error = { code: 'RECORDING_ABANDONED', message: 'The recording was interrupted before any audio was captured.', stage: 'upload', retryable: false };
      await rec.save();
      emitRecordingUpdate(rec);
    }
  }
}

export function startSweeper() {
  timer = setInterval(() => sweepAbandonedRecordings().catch((err) => logger.error('Sweeper failed', { error: err.message })), INTERVAL_MS);
}

export function stopSweeper() {
  clearInterval(timer);
}
