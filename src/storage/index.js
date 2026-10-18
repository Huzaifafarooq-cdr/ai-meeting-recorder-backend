import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import { env } from '../config/env.js';

// audio is kept in MongoDB GridFS so it survives restarts on hosts without a persistent disk.
// local disk is only a working copy (live recording, uploads, processing)
const ROOT = path.resolve(env.STORAGE_DIR);
export const TMP_DIR = path.join(ROOT, 'tmp');

const MIME_EXT = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
};

export function extForMime(mime = '') {
  return MIME_EXT[mime.split(';')[0].trim().toLowerCase()] ?? 'bin';
}

export function audioKey(userId, recordingId, mime) {
  return `audio/${userId}/${recordingId}.${extForMime(mime)}`;
}

export function resolvePath(key) {
  const full = path.resolve(ROOT, key);
  if (!full.startsWith(ROOT + path.sep)) throw new Error('Invalid storage key');
  return full;
}

export async function ensureStorage() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

export async function ensureDirFor(key) {
  await fsp.mkdir(path.dirname(resolvePath(key)), { recursive: true });
}

export function createAppendStream(key) {
  return fs.createWriteStream(resolvePath(key), { flags: 'a' });
}

export async function moveInto(tmpPath, key) {
  await ensureDirFor(key);
  const dest = resolvePath(key);
  try {
    await fsp.rename(tmpPath, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(tmpPath, dest);
    await fsp.unlink(tmpPath);
  }
}

// local working copy
export async function stat(key) {
  if (!key) return null;
  try {
    return await fsp.stat(resolvePath(key));
  } catch {
    return null;
  }
}

let bucket;
const gridfs = () => (bucket ??= new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'audio' }));

export async function findStored(key) {
  if (!key) return null;
  return gridfs().find({ filename: key }).sort({ uploadDate: -1 }).limit(1).next();
}

async function removeStored(key, keepId) {
  const files = await gridfs().find({ filename: key }).toArray();
  await Promise.all(files.filter((f) => !keepId?.equals(f._id)).map((f) => gridfs().delete(f._id)));
}

export function openStoredStream(id, range) {
  return gridfs().openDownloadStream(id, range);
}

// copy the local file into GridFS (skipped if the same file is already there)
export async function persist(key, contentType) {
  const local = await stat(key);
  if (!local) throw new Error(`No local audio for ${key}`);
  const stored = await findStored(key);
  if (stored?.length === local.size) return;
  const upload = gridfs().openUploadStream(key, { metadata: { contentType } });
  await pipeline(fs.createReadStream(resolvePath(key)), upload);
  await removeStored(key, upload.id);
}

// download from GridFS when the local copy is gone (restart, other machine)
export async function restoreLocal(key) {
  if (!key || (await stat(key))) return;
  const stored = await findStored(key);
  if (!stored) return;
  await ensureDirFor(key);
  const part = `${resolvePath(key)}.part`;
  await pipeline(gridfs().openDownloadStream(stored._id), fs.createWriteStream(part));
  await fsp.rename(part, resolvePath(key));
}

export async function dropLocalCopy(key) {
  const local = await stat(key);
  if (!local) return;
  const stored = await findStored(key);
  if (stored?.length === local.size) await fsp.rm(resolvePath(key), { force: true });
}

export async function audioExists(key) {
  return Boolean((await findStored(key)) || (await stat(key)));
}

export async function remove(key) {
  if (!key) return;
  await Promise.all([fsp.rm(resolvePath(key), { force: true }), removeStored(key)]);
}
