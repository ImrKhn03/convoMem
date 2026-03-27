'use strict';

const { Router } = require('express');
const ctrl = require('../controllers/auth.controller');
const { authMiddleware } = require('../middleware/auth');
const { authRateLimiter } = require('../middleware/rateLimiter');

const router = Router();

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               name: { type: string }
 *     responses:
 *       201:
 *         description: User registered successfully
 *       409:
 *         description: Email already registered
 */
router.post('/register', authRateLimiter, ctrl.register);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login
 *     tags: [Auth]
 */
router.post('/login', authRateLimiter, ctrl.login);

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh access token
 *     tags: [Auth]
 */
router.post('/refresh', ctrl.refresh);

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout (revoke refresh token)
 *     tags: [Auth]
 */
router.post('/logout', ctrl.logout);

// API key management (requires auth)
router.post('/api-keys', authMiddleware, ctrl.createApiKey);
router.get('/api-keys', authMiddleware, ctrl.listApiKeys);
router.delete('/api-keys/:keyId', authMiddleware, ctrl.deleteApiKey);

module.exports = router;
