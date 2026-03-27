'use strict';

const { sha256, verifyAccessToken } = require('../utils/tokens');
const { getDb } = require('../config/db');
const { AuthError } = require('../utils/errors');

/**
 * Authentication middleware.
 * Accepts:
 *  - Bearer JWT in Authorization header
 *  - API key (sk-cm-*) in Authorization header or X-API-Key header
 *
 * Sets req.userId.
 */
async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'];

    let userId;

    // --- API Key path ---
    const rawKey = apiKeyHeader || (authHeader && authHeader.startsWith('sk-cm-') ? authHeader : null);
    if (rawKey) {
      const keyHash = sha256(rawKey);
      const db = getDb();
      const apiKey = await db.apiKey.findUnique({
        where: { keyHash },
        include: { user: { select: { id: true } } },
      });

      if (!apiKey) throw new AuthError('Invalid API key');

      // Update last used (fire-and-forget)
      db.apiKey.update({ where: { id: apiKey.id }, data: { lastUsed: new Date() } }).catch(() => {});

      userId = apiKey.user.id;
    }

    // --- JWT path ---
    else if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      let payload;
      try {
        payload = verifyAccessToken(token);
      } catch {
        throw new AuthError('Invalid or expired token');
      }
      userId = payload.sub;
    } else {
      throw new AuthError('No authentication provided');
    }

    req.userId = userId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authMiddleware };
