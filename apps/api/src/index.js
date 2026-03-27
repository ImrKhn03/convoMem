'use strict';

// Load environment variables first
require('dotenv').config();

const { validateEnv } = require('./config/env');
const { getDb } = require('./config/db');
const { setupCollections } = require('./config/qdrant');
const { startCaptureWorker } = require('./jobs/capture.worker');
const { startWebhookDeliveryWorker } = require('./jobs/webhook-delivery.worker');
const { scheduleCleanup } = require('./jobs/cleanup.job');
const { getBoss, stopBoss } = require('./config/pgboss');
const logger = require('./utils/logger');
const app = require('./app');

const PORT = parseInt(process.env.PORT) || 8000;

async function start() {
  try {
    // Validate environment
    validateEnv();
    logger.info('Environment validated');

    // Connect to database
    const db = getDb();
    await db.$connect();
    logger.info('Database connected');

    // Setup Qdrant collections
    await setupCollections();
    logger.info('Qdrant collections ready');

    // Start pg-boss and register workers
    const boss = await getBoss();
    await startCaptureWorker(boss);
    await startWebhookDeliveryWorker(boss);

    // Schedule cleanup jobs
    scheduleCleanup();

    // Start HTTP server
    const server = app.listen(PORT, () => {
      logger.info({ port: PORT }, `ConvoMem API listening`);
      logger.info(`API docs: http://localhost:${PORT}/api/docs`);
    });

    // Graceful shutdown
    async function shutdown(signal) {
      logger.info({ signal }, 'Shutting down gracefully...');

      // Stop accepting new HTTP connections
      server.close(async () => {
        try {
          // Stop pg-boss — drains in-flight jobs then stops all workers
          await stopBoss();
          logger.info('Workers drained');

          // Disconnect Prisma
          await db.$disconnect();

          logger.info('Graceful shutdown complete');
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'Error during shutdown');
          process.exit(1);
        }
      });

      // Force exit after 30s (give workers time to finish in-flight jobs)
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30_000);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();
