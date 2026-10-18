import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../lib/AppError.js';
import { TMP_DIR } from '../storage/index.js';

const EXT_MIME = {
  '.mp3': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.weba': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
};
const GENERIC_MIMES = new Set(['application/octet-stream', 'video/webm', 'video/mp4', '']);

export function audioMimeFor(file) {
  const ext = path.extname(file.originalname ?? '').toLowerCase();
  if (file.mimetype?.startsWith('audio/')) return file.mimetype.split(';')[0];
  return EXT_MIME[ext] ?? null;
}

export const audioUpload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.upload`),
  }),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname ?? '').toLowerCase();
    const typeOk = file.mimetype?.startsWith('audio/') || (GENERIC_MIMES.has(file.mimetype ?? '') && EXT_MIME[ext]);
    if (typeOk && audioMimeFor(file)) return cb(null, true);
    cb(new AppError(415, 'UNSUPPORTED_FORMAT', 'Unsupported file type. Please upload an audio file (MP3, WAV, M4A, WebM, OGG, FLAC or AAC).'));
  },
}).single('audio');
