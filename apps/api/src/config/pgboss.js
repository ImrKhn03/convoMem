'use strict';

const { PgBoss } = require('pg-boss');
const logger = require('../utils/logger');

/** @type {PgBoss} */
let boss;

/**
 * Returns the pg-boss singleton. Starts it on first call.
 * @returns {Promise<PgBoss>}
 */
async function getBoss() {
  if (!boss) {
    boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      retentionMinutes: 1440, // keep job history 24h
    });
    boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
    await boss.start();

    // pg-boss v10 requires queues to be created before workers can subscribe
    const { QUEUES } = require('../jobs/queues');
    await Promise.all(Object.values(QUEUES).map((name) => boss.createQueue(name)));
    logger.info('pg-boss started and queues created');
  }
  return boss;
}

/**
 * Stop pg-boss gracefully (drains in-flight jobs).
 */
async function stopBoss() {
  if (boss) {
    await boss.stop();
    boss = null;
    logger.info('pg-boss stopped');
  }
}

module.exports = { getBoss, stopBoss };
