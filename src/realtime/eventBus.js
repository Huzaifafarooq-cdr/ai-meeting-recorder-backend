import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import { logger } from '../lib/logger.js';
import { toSummary } from '../modules/recordings/recordings.serializer.js';

// local emitter. standalone workers write to a capped collection that the API tails
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const RELAY_COLLECTION = 'realtime_events';
let relayPublishing = false;
let listening = false;

const relay = () => mongoose.connection.db.collection(RELAY_COLLECTION);

async function ensureRelayCollection() {
  try {
    await mongoose.connection.db.createCollection(RELAY_COLLECTION, { capped: true, size: 1024 * 1024, max: 1000 });
  } catch (err) {
    if (err.codeName !== 'NamespaceExists') throw err;
  }
}

export function enableRelayPublishing() {
  relayPublishing = true;
}

export function publishToUser(userId, event) {
  if (!relayPublishing) {
    emitter.emit(`user:${userId}`, event);
    return;
  }
  relay()
    .insertOne({ userId, event, at: new Date() })
    .catch((err) => logger.warn('Could not relay realtime event', { error: err.message }));
}

export async function startRelayListener() {
  if (listening) return;
  listening = true;
  await ensureRelayCollection();
  // tailable cursor needs at least one doc
  const last = await relay().find().sort({ $natural: -1 }).limit(1).next();
  let lastId = last?._id ?? (await relay().insertOne({ at: new Date() })).insertedId;

  (async () => {
    while (listening) {
      try {
        const cursor = relay().find({ _id: { $gt: lastId } }, { tailable: true, awaitData: true });
        for await (const doc of cursor) {
          lastId = doc._id;
          if (doc.userId && doc.event) emitter.emit(`user:${doc.userId}`, doc.event);
          if (!listening) break;
        }
      } catch (err) {
        if (listening) logger.warn('Realtime relay cursor interrupted, reconnecting', { error: err.message });
      }
      if (listening) await new Promise((r) => setTimeout(r, 1000));
    }
  })();
}

export function stopRelayListener() {
  listening = false;
}

export function subscribeUser(userId, listener) {
  const channel = `user:${userId}`;
  emitter.on(channel, listener);
  return () => emitter.off(channel, listener);
}

export function emitRecordingUpdate(rec) {
  publishToUser(rec.user.toString(), { type: 'recording.updated', recording: toSummary(rec) });
}

export function emitRecordingDeleted(userId, recordingId) {
  publishToUser(userId.toString(), { type: 'recording.deleted', id: recordingId.toString() });
}
