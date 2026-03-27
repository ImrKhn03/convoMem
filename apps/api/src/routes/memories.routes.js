'use strict';

const { Router } = require('express');
const ctrl = require('../controllers/memories.controller');
const { authMiddleware } = require('../middleware/auth');
const { defaultRateLimiter } = require('../middleware/rateLimiter');

const router = Router();

// All memory routes require authentication
router.use(authMiddleware);
router.use(defaultRateLimiter);

/**
 * @swagger
 * /api/memories/capture:
 *   post:
 *     summary: Capture memories from a conversation
 *     tags: [Memories]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messages]
 *             properties:
 *               messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     role: { type: string }
 *                     content: { type: string }
 *               platform: { type: string }
 *     responses:
 *       202:
 *         description: Queued for processing
 */
router.post('/capture', ctrl.capture);

/**
 * @swagger
 * /api/memories/lookup:
 *   get:
 *     summary: Look up relevant memory context for a topic
 *     tags: [Memories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: topic
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Formatted memory context
 */
router.get('/lookup', ctrl.lookup);

/**
 * @swagger
 * /api/memories/lookup-feedback:
 *   post:
 *     summary: Submit feedback on looked-up memories
 *     tags: [Memories]
 */
router.post('/lookup-feedback', ctrl.lookupFeedback);

/**
 * @swagger
 * /api/memories/search:
 *   get:
 *     summary: Semantic search across memories
 *     tags: [Memories]
 */
router.get('/search', ctrl.search);

/**
 * @swagger
 * /api/memories:
 *   post:
 *     summary: Manually create a memory
 *     tags: [Memories]
 *   get:
 *     summary: List all memories (paginated)
 *     tags: [Memories]
 */
router.get('/capture/:captureId', ctrl.captureStatus);
router.post('/', ctrl.create);
router.get('/', ctrl.list);

/**
 * @swagger
 * /api/memories/{id}:
 *   get:
 *     summary: Get a single memory
 *     tags: [Memories]
 *   delete:
 *     summary: Delete a memory
 *     tags: [Memories]
 */
router.get('/:id', ctrl.getOne);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
