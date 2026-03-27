'use strict';

const { QUEUES } = require('./queues');
const { runCapturePipeline } = require('../services/capture.service');
const { getDb } = require('../config/db');
const logger = require('../utils/logger');

/**
 * Start the pg-boss capture worker.
 * @param {import('pg-boss')} boss
 */
async function startCaptureWorker(boss) {
  await boss.work(QUEUES.CAPTURE, { teamSize: 5, teamConcurrency: 5 }, async (job) => {
    const { userId, captureId, messages, opts } = job.data;
    logger.info({ jobId: job.id, userId, captureId }, 'Processing capture job');

    const results = await runCapturePipeline(userId, messages, { ...(opts || {}), captureId });

    // Fire webhook events for saved memories (non-blocking)
    if (results.saved && results.saved > 0) {
      const { dispatchEvent } = require('../services/webhook.service');
      dispatchEvent(userId, 'memory.captured', {
        saved: results.saved,
        skipped: results.skipped,
        platform: opts?.platform || null,
        jobId: job.id,
      });
    }

    // Persist result so captureStatus can report completion even when saved=0 (all skipped/filtered)
    try {
      const db = getDb();
      await db.captureResult.upsert({
        where: { captureId },
        update: { saved: results.saved || 0, skipped: results.skipped || 0 },
        create: { captureId, userId, saved: results.saved || 0, skipped: results.skipped || 0 },
      });
    } catch { /* non-fatal */ }

    logger.info({ jobId: job.id, userId, results }, 'Capture job complete');
    return results;
  });

  logger.info('Capture worker started (teamSize: 5)');
}

module.exports = { startCaptureWorker };
