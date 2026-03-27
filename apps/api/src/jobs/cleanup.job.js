'use strict';

const { getDb } = require('../config/db');
const { getQdrant, PERSONAL_COLLECTION } = require('../config/qdrant');
const logger = require('../utils/logger');

/**
 * Delete all memories that have passed their expiresAt timestamp.
 */
async function runCleanup() {
  const db = getDb();
  const qdrant = getQdrant();

  logger.info('Memory cleanup job started');

  try {
    const expired = await db.memory.findMany({
      where: {
        expiresAt: { lte: new Date() },
      },
      select: { id: true, userId: true, qdrantId: true },
    });

    if (expired.length === 0) {
      logger.info('No expired memories to clean up');
    } else {
      const qdrantIds = expired.map((m) => m.qdrantId).filter(Boolean);
      if (qdrantIds.length > 0) await qdrant.delete(PERSONAL_COLLECTION, { points: qdrantIds });

      const ids = expired.map((m) => m.id);
      await db.memory.deleteMany({ where: { id: { in: ids } } });

      const countsByUser = expired.reduce((acc, m) => {
        acc[m.userId] = (acc[m.userId] || 0) + 1;
        return acc;
      }, {});

      await Promise.all(
        Object.entries(countsByUser).map(([userId, count]) =>
          db.user.update({
            where: { id: userId },
            data: { memoryCount: { decrement: count } },
          })
        )
      );

      logger.info({ deleted: expired.length }, 'Memory cleanup complete');
    }

    // Clean up stale CaptureResult rows (older than 2 hours)
    await db.captureResult.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
    }).catch(() => {});

    logger.info('Memory cleanup job finished');
    return { deleted: expired.length };
  } catch (err) {
    logger.error({ err }, 'Memory cleanup job failed');
    throw err;
  }
}

/**
 * Schedule the cleanup job to run every 24 hours.
 */
function scheduleCleanup() {
  const INTERVAL_MS = 24 * 60 * 60 * 1000;

  setTimeout(() => {
    runCleanup().catch(() => {});
  }, 5000);

  setInterval(() => {
    runCleanup().catch(() => {});
  }, INTERVAL_MS);

  logger.info('Memory cleanup job scheduled (every 24h)');
}

module.exports = { runCleanup, scheduleCleanup };
