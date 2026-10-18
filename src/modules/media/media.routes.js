import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { notFound } from '../../lib/AppError.js';
import { validId } from '../../middleware/validate.js';
import { Recording } from '../../models/Recording.js';
import { extForMime, findStored, openStoredStream, resolvePath, stat } from '../../storage/index.js';
import { verifyMediaToken } from '../auth/tokens.js';

export const mediaRouter = Router();

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : 'invalid';
}

function attachment(rec) {
  const ext = extForMime(rec.audio.mimeType);
  const base = (rec.title || 'recording').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'recording';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
}

mediaRouter.get(
  '/:id',
  validId(),
  asyncHandler(async (req, res) => {
    const { userId } = verifyMediaToken(req.query.token, req.params.id);
    const rec = await Recording.findOne({ _id: req.params.id, user: userId }).select('audio title');
    if (!rec?.audio?.key) throw notFound('Audio');
    const headers = {
      'Content-Type': rec.audio.mimeType || 'application/octet-stream',
      'Cache-Control': 'private, max-age=600',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    if (req.query.download === '1') headers['Content-Disposition'] = attachment(rec);

    const stored = await findStored(rec.audio.key);
    if (!stored) {
      if (!(await stat(rec.audio.key))) throw notFound('Audio');
      return res.sendFile(resolvePath(rec.audio.key), { headers });
    }

    const size = stored.length;
    const range = parseRange(req.headers.range, size);
    res.set({ ...headers, 'Accept-Ranges': 'bytes' });
    if (range === 'invalid') {
      return res.status(416).set('Content-Range', `bytes */${size}`).end();
    }
    if (range) {
      res.status(206).set({ 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1 });
    } else {
      res.set('Content-Length', size);
    }
    const stream = openStoredStream(stored._id, range ? { start: range.start, end: range.end + 1 } : undefined);
    await pipeline(stream, res).catch(() => {});
  })
);
