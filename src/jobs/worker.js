// standalone worker (npm run worker). needs a shared MongoDB, set RUN_WORKER=false on the API
import { connectDB, disconnectDB } from '../config/db.js';
import { ensureStorage } from '../storage/index.js';
import { logger } from '../lib/logger.js';
import { enableRelayPublishing } from '../realtime/eventBus.js';
import { startWorker, stopWorker } from './queue.js';
import { startSweeper, stopSweeper } from './sweeper.js';

await connectDB();
await ensureStorage();
enableRelayPublishing();
startWorker();
startSweeper();

const shutdown = async (signal) => {
  logger.info(`${signal} received, draining worker…`);
  stopSweeper();
  await stopWorker();
  await disconnectDB();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
