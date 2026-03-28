'use strict';

const selectors = {
  version: '1.0.0',
  chatgpt: {
    conversation: "[data-testid='conversation-turn']",
    userMessage: "[data-message-author='user']",
    assistantMessage: "[data-message-author='assistant']",
    inputBox: '#prompt-textarea'
  },
  claude: {
    conversation: "[data-testid='conversation-message']",
    userMessage: "[data-role='user']",
    assistantMessage: "[data-role='assistant']",
    inputBox: "[contenteditable='true']"
  }
};

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
