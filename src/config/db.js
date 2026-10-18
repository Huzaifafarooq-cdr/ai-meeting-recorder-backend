import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../lib/logger.js';

let memoryServer = null;

async function startEmbeddedMongo() {
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = await import('mongodb-memory-server'));
  } catch {
    throw new Error(
      'USE_IN_MEMORY_DB=true but "mongodb-memory-server" is not installed. Run `npm install`, or set USE_IN_MEMORY_DB=false and provide MONGODB_URI.'
    );
  }
  const dbPath = path.resolve(env.STORAGE_DIR, 'mongo-data');
  fs.mkdirSync(dbPath, { recursive: true });
  memoryServer = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger', port: 27027 } });
  logger.warn('Using embedded MongoDB (USE_IN_MEMORY_DB=true). Use a real MongoDB/Atlas URI in production.', { dbPath });
  return memoryServer.getUri('ai_meeting_recorder');
}

export async function connectDB() {
  mongoose.set('strictQuery', true);
  const uri = env.USE_IN_MEMORY_DB ? await startEmbeddedMongo() : env.MONGODB_URI;

  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));

  try {
    await mongoose.connect(uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 10000 });
  } catch (err) {
    throw new Error(`Could not connect to MongoDB at ${uri.replace(/\/\/[^@]*@/, '//***@')}: ${err.message}`);
  }
  logger.info('MongoDB connected');
}

export async function disconnectDB() {
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop({ doCleanup: false });
}

export const isDbReady = () => mongoose.connection.readyState === 1;
