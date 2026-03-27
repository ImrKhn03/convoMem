'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { getDb } = require('../config/db');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { dispatchEvent } = require('../services/webhook.service');

const createSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
});

const updateSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string()).min(1).optional(),
  isActive: z.boolean().optional(),
});

/**
 * List all webhooks for the authenticated user (with delivery count).
 */
async function list(req, res, next) {
  try {
    const db = getDb();
    const webhooks = await db.userWebhook.findMany({
      where: { userId: req.userId },
      include: { _count: { select: { deliveries: true } } },
    });
    res.json({ webhooks });
  } catch (err) {
    next(err);
  }
}

/**
 * Create a new webhook endpoint.
 */
async function create(req, res, next) {
  try {
    let parsed;
    try {
      parsed = createSchema.parse(req.body);
    } catch (e) {
      throw new ValidationError('Invalid request body', e.errors);
    }

    const db = getDb();
    const secret = crypto.randomBytes(32).toString('hex');

    const webhook = await db.userWebhook.create({
      data: {
        userId: req.userId,
        url: parsed.url,
        events: parsed.events,
        secret,
        isActive: true,
      },
    });

    res.status(201).json({
      webhook,
      secret,
      note: 'Store this secret securely, it will not be shown again',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update an existing webhook endpoint.
 */
async function update(req, res, next) {
  try {
    let parsed;
    try {
      parsed = updateSchema.parse(req.body);
    } catch (e) {
      throw new ValidationError('Invalid request body', e.errors);
    }

    const db = getDb();
    const existing = await db.userWebhook.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.userId) {
      throw new NotFoundError('Webhook not found');
    }

    const webhook = await db.userWebhook.update({
      where: { id: req.params.id },
      data: {
        ...(parsed.url !== undefined && { url: parsed.url }),
        ...(parsed.events !== undefined && { events: parsed.events }),
        ...(parsed.isActive !== undefined && { isActive: parsed.isActive }),
      },
      select: {
        id: true,
        userId: true,
        url: true,
        events: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({ webhook });
  } catch (err) {
    next(err);
  }
}

/**
 * Delete a webhook endpoint.
 */
async function remove(req, res, next) {
  try {
    const db = getDb();
    const existing = await db.userWebhook.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.userId) {
      throw new NotFoundError('Webhook not found');
    }

    await db.userWebhook.delete({ where: { id: req.params.id } });
    res.json({ message: 'Webhook deleted' });
  } catch (err) {
    next(err);
  }
}

/**
 * Get the last 50 delivery attempts for a webhook.
 */
async function getDeliveries(req, res, next) {
  try {
    const db = getDb();
    const existing = await db.userWebhook.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.userId) {
      throw new NotFoundError('Webhook not found');
    }

    const deliveries = await db.webhookDelivery.findMany({
      where: { webhookId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({ deliveries });
  } catch (err) {
    next(err);
  }
}

/**
 * Dispatch a test event to a webhook.
 */
async function testWebhook(req, res, next) {
  try {
    const db = getDb();
    const existing = await db.userWebhook.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.userId) {
      throw new NotFoundError('Webhook not found');
    }

    await dispatchEvent(req.userId, 'webhook.test', {
      message: 'Test webhook from ConvoMem',
      webhookId: req.params.id,
    });

    res.json({ message: 'Test event dispatched' });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, update, remove, getDeliveries, testWebhook };
