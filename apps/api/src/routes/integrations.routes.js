'use strict'

const { Router } = require('express')
const ctrl = require('../controllers/integrations.controller')
const { authMiddleware } = require('../middleware/auth')
const { defaultRateLimiter } = require('../middleware/rateLimiter')

const router = Router()

router.use(authMiddleware)
router.use(defaultRateLimiter)

/**
 * @swagger
 * tags:
 *   name: Integrations
 *   description: Manage platform integrations (Cursor, Claude, ChatGPT, Copilot, etc.)
 */

/**
 * @swagger
 * /api/integrations:
 *   get:
 *     summary: List all supported integrations with their status
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Integration list with active count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 integrations:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Integration'
 *                 active:
 *                   type: integer
 *                   description: Number of currently active integrations
 *                 total:
 *                   type: integer
 *                   description: Total number of supported platforms
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests
 */
router.get('/', ctrl.list)

/**
 * @swagger
 * /api/integrations/{platform}:
 *   patch:
 *     summary: Enable or disable an integration
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: platform
 *         required: true
 *         schema:
 *           type: string
 *           enum: [cursor, claude, chatgpt, copilot]
 *         description: Platform identifier (comingSoon platforms cannot be activated)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - isActive
 *             properties:
 *               isActive:
 *                 type: boolean
 *                 description: Whether the integration should be active
 *     responses:
 *       200:
 *         description: Updated integration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 integration:
 *                   $ref: '#/components/schemas/Integration'
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Validation error (unsupported platform or comingSoon)
 *       429:
 *         description: Too many requests
 */
router.patch('/:platform', ctrl.toggle)

/**
 * @swagger
 * components:
 *   schemas:
 *     Integration:
 *       type: object
 *       properties:
 *         platform:
 *           type: string
 *           example: cursor
 *         label:
 *           type: string
 *           example: Cursor IDE
 *         description:
 *           type: string
 *           example: AI code editor
 *         comingSoon:
 *           type: boolean
 *           example: false
 *         isActive:
 *           type: boolean
 *           example: true
 *         lastSyncAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         memoriesCount:
 *           type: integer
 *           example: 42
 */

module.exports = router
