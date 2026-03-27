'use strict'
const { Router } = require('express')
const ctrl = require('../controllers/stats.controller')
const { authMiddleware } = require('../middleware/auth')
const { defaultRateLimiter } = require('../middleware/rateLimiter')

const router = Router()
router.use(authMiddleware)
router.use(defaultRateLimiter)

/**
 * @swagger
 * /api/stats:
 *   get:
 *     summary: Get dashboard statistics
 *     tags: [Stats]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard stats
 */
router.get('/', ctrl.getDashboard)
router.get('/openai-usage', ctrl.getOpenAIUsage)

module.exports = router
