'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { QUEUES } = require('./queues');
const { getDb } = require('../config/db');
const logger = require('../utils/logger');

/**
 * Sign a payload with HMAC-SHA256.
 * @param {string} secret
 * @param {string} body
 * @returns {string}
 */
function signPayload(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Deliver a single webhook POST request.
 * @param {string} url
 * @param {string} secret
 * @param {object} payload
 * @returns {Promise<{ statusCode: number, success: boolean }>}
 */
async function deliverWebhook(url, secret, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const sig = signPayload(secret, body);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-ConvoMem-Signature': sig,
        'X-ConvoMem-Event': payload.event,
        'User-Agent': 'ConvoMem-Webhooks/1.0',
      },
      timeout: 10000,
    };
    const proto = parsed.protocol === 'https:' ? https : http;
    const req = proto.request(options, (res) => {
      resolve({ statusCode: res.statusCode, success: res.statusCode >= 200 && res.statusCode < 300 });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Start the pg-boss webhook delivery worker.
 * @param {import('pg-boss')} boss
 */
async function startWebhookDeliveryWorker(boss) {
  await boss.work(QUEUES.WEBHOOK, { teamSize: 10, teamConcurrency: 10 }, async ([job]) => {
    const { webhookId, url, secret, event, payload } = job.data;
    const db = getDb();

    let statusCode = null;
    let success = false;

    try {
      const result = await deliverWebhook(url, secret, payload);
      statusCode = result.statusCode;
      success = result.success;
    } catch (err) {
      logger.warn({ webhookId, event, err: err.message }, 'Webhook delivery failed');
    }

    // Log delivery attempt regardless of outcome
    await db.webhookDelivery.create({
      data: {
        webhookId,
        event,
        payload,
        statusCode,
        success,
        attemptCount: (job.retryCount || 0) + 1,
      },
    });

    if (!success) {
      throw new Error(`Delivery failed: statusCode=${statusCode}`);
    }

    return { statusCode, success };
  });

  logger.info('Webhook delivery worker started');
}

module.exports = { startWebhookDeliveryWorker };
