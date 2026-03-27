'use strict';

const selectors = require('../config/selectors.json');

/**
 * @swagger
 * /api/extension/selectors:
 *   get:
 *     summary: Get DOM selectors for browser extension content scripts
 *     description: Returns the current CSS selectors for each supported AI platform. Extension fetches and caches these so selector updates happen server-side without a Chrome Web Store release.
 *     tags: [Extension]
 *     responses:
 *       200:
 *         description: Selector config object keyed by platform
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 version:
 *                   type: string
 *                 chatgpt:
 *                   type: object
 *                 claude:
 *                   type: object
 */
exports.getSelectors = (req, res) => {
  res.json(selectors);
};
