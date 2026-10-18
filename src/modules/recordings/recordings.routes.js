import { Router } from 'express';
import { z } from 'zod';
import { STATUSES } from '../../models/Recording.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { audioUpload } from '../../middleware/upload.js';
import { uploadLimiter } from '../../middleware/rateLimiters.js';
import { validate, validId } from '../../middleware/validate.js';
import { signMediaToken } from '../auth/tokens.js';
import * as service from './recordings.service.js';

const optional = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

const listQuery = z.object({
  q: optional(z.string().trim().max(200)),
  from: optional(z.coerce.date()),
  to: optional(z.coerce.date()),
  status: optional(z.enum([...STATUSES, 'in_progress'])),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
const createBody = z.object({
  title: optional(z.string().trim().max(200)),
  mimeType: z
    .string()
    .max(100)
    .regex(/^(audio|video)\/[\w.+-]+(;.*)?$/, 'Unsupported recording format.')
    .default('audio/webm'),
});
const uploadFields = z.object({
  title: optional(z.string().trim().max(200)),
  durationSec: optional(z.coerce.number().min(0).max(24 * 3600)),
});
const finalizeBody = z.object({
  durationSec: z.coerce.number().min(0).max(24 * 3600),
  totalChunks: z.coerce.number().int().min(0),
});
const updateBody = z.object({ title: z.string().trim().min(1, 'Title cannot be empty.').max(200) });
const speakersBody = z.object({
  speakers: z.array(z.object({ label: z.string().max(40), name: z.string().trim().max(60) })).max(50),
});
const transcriptQuery = z.object({ kind: z.enum(['final', 'live']).default('final') });

export const recordingsRouter = Router();

recordingsRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => res.json(await service.list(req.user.id, req.validatedQuery)))
);

recordingsRouter.get(
  '/stats',
  asyncHandler(async (req, res) => res.json(await service.stats(req.user.id)))
);

recordingsRouter.post(
  '/',
  validate({ body: createBody }),
  asyncHandler(async (req, res) => res.status(201).json({ recording: await service.createLive(req.user.id, req.body) }))
);

recordingsRouter.post(
  '/upload',
  uploadLimiter,
  audioUpload,
  asyncHandler(async (req, res) => {
    const fields = uploadFields.parse(req.body ?? {});
    res.status(201).json({ recording: await service.createFromUpload(req.user.id, req.file, fields) });
  })
);

recordingsRouter.get(
  '/:id',
  validId(),
  asyncHandler(async (req, res) => res.json({ recording: await service.getDetail(req.user.id, req.params.id) }))
);

recordingsRouter.get(
  '/:id/transcript',
  validId(),
  validate({ query: transcriptQuery }),
  asyncHandler(async (req, res) => res.json(await service.getTranscript(req.user.id, req.params.id, req.validatedQuery.kind)))
);

recordingsRouter.post(
  '/:id/finalize',
  validId(),
  validate({ body: finalizeBody }),
  asyncHandler(async (req, res) => res.json({ recording: await service.finalize(req.user.id, req.params.id, req.body) }))
);

recordingsRouter.put(
  '/:id/audio',
  validId(),
  uploadLimiter,
  audioUpload,
  asyncHandler(async (req, res) => {
    const fields = uploadFields.parse(req.body ?? {});
    res.json({ recording: await service.replaceAudio(req.user.id, req.params.id, req.file, fields) });
  })
);

recordingsRouter.patch(
  '/:id',
  validId(),
  validate({ body: updateBody }),
  asyncHandler(async (req, res) => res.json({ recording: await service.update(req.user.id, req.params.id, req.body) }))
);

recordingsRouter.patch(
  '/:id/speakers',
  validId(),
  validate({ body: speakersBody }),
  asyncHandler(async (req, res) => res.json({ recording: await service.renameSpeakers(req.user.id, req.params.id, req.body.speakers) }))
);

const actionItemParams = z.object({ index: z.coerce.number().int().min(0).max(500) });
const actionItemBody = z.object({ done: z.boolean() });

recordingsRouter.patch(
  '/:id/action-items/:index',
  validId(),
  validate({ body: actionItemBody }),
  asyncHandler(async (req, res) => {
    const { index } = actionItemParams.parse(req.params);
    res.json({ recording: await service.setActionItemDone(req.user.id, req.params.id, index, req.body.done) });
  })
);

recordingsRouter.post(
  '/:id/retry',
  validId(),
  asyncHandler(async (req, res) => res.json({ recording: await service.retry(req.user.id, req.params.id) }))
);

recordingsRouter.get(
  '/:id/media-url',
  validId(),
  asyncHandler(async (req, res) => {
    const rec = await service.getAudioInfo(req.user.id, req.params.id);
    const token = signMediaToken(req.user.id, rec._id);
    res.json({ url: `/api/media/${rec._id}?token=${encodeURIComponent(token)}`, mimeType: rec.audio.mimeType });
  })
);

recordingsRouter.delete(
  '/:id',
  validId(),
  asyncHandler(async (req, res) => {
    await service.removeRecording(req.user.id, req.params.id);
    res.status(204).end();
  })
);
