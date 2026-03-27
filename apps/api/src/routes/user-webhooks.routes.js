'use strict';

const { Router } = require('express');
const ctrl = require('../controllers/user-webhooks.controller');
const { authMiddleware } = require('../middleware/auth');
const { defaultRateLimiter } = require('../middleware/rateLimiter');

const router = Router();

router.use(authMiddleware, defaultRateLimiter);

/**
 * @swagger
 * /api/webhooks:
 *   get:
 *     summary: List all webhook endpoints for the authenticated user
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of webhooks with delivery count
 */
router.get('/', ctrl.list);

/**
 * @swagger
 * /api/webhooks:
 *   post:
 *     summary: Create a new webhook endpoint
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, events]
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *               events:
 *                 type: array
 *                 items:
 *                   type: string
 *                 minItems: 1
 *     responses:
 *       201:
 *         description: Created webhook. Secret is shown once — store it securely.
 */
router.post('/', ctrl.create);

/**
 * @swagger
 * /api/webhooks/{id}:
 *   patch:
 *     summary: Update an existing webhook endpoint
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Updated webhook (secret not included)
 */
router.patch('/:id', ctrl.update);

/**
 * @swagger
 * /api/webhooks/{id}:
 *   delete:
 *     summary: Delete a webhook endpoint
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Webhook deleted
 */
router.delete('/:id', ctrl.remove);

/**
 * @swagger
 * /api/webhooks/{id}/deliveries:
 *   get:
 *     summary: Get the last 50 delivery attempts for a webhook
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of delivery attempts ordered by newest first
 */
router.get('/:id/deliveries', ctrl.getDeliveries);

/**
 * @swagger
 * /api/webhooks/{id}/test:
 *   post:
 *     summary: Dispatch a test event to a webhook
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Test event enqueued for delivery
 */
router.post('/:id/test', ctrl.testWebhook);

module.exports = router;
