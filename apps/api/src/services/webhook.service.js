'use strict';

const { getDb } = require('../config/db');
const { QUEUES } = require('../jobs/queues');
const { getBoss } = require('../config/pgboss');
const logger = require('../utils/logger');

/** Supported outbound events */
const WEBHOOK_EVENTS = [
  'memory.captured',
  'memory.created',
  'memory.updated',
  'memory.deleted',
  'lookup.completed',
  'integration.toggled',
];

/**
 * Enqueue webhook deliveries for all active webhooks subscribed to this event.
 * Fire-and-forget — never throws.
 * @param {string} userId
 * @param {string} event
 * @param {object} payload
 */
async function dispatchEvent(userId, event, payload) {
  try {
    const db = getDb();
    const webhooks = await db.userWebhook.findMany({
      where: { userId, isActive: true },
    });

    const subscribed = webhooks.filter(
      (w) => w.events.includes(event) || w.events.includes('*')
    );
    if (subscribed.length === 0) return;

    const boss = await getBoss();
    await Promise.all(
      subscribed.map((w) =>
        boss.send(QUEUES.WEBHOOK, {
          webhookId: w.id,
          userId,
          url: w.url,
          secret: w.secret,
          event,
          payload: { event, createdAt: new Date().toISOString(), data: payload },
        }, { retryLimit: 3, retryDelay: 5, retryBackoff: true })
      )
    );
  } catch (err) {
    logger.error({ err, userId, event }, 'dispatchEvent error (non-fatal)');
  }
}

module.exports = { WEBHOOK_EVENTS, dispatchEvent };
