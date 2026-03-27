'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/db');

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

/**
 * Issue a short-lived JWT access token.
 * @param {string} userId
 * @param {string} email
 * @returns {string}
 */
function issueAccessToken(userId, email) {
  return jwt.sign(
    { sub: userId, email },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

/**
 * Verify a JWT access token.
 * @param {string} token
 * @returns {{ sub: string, email: string }}
 */
function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}

/**
 * Generate, hash, and store a refresh token.
 * Returns the raw token to send to the client once.
 * @param {string} userId
 * @param {string} familyId - UUID for refresh token family (reuse detection)
 * @returns {Promise<string>} raw refresh token
 */
async function issueRefreshToken(userId, familyId) {
  const rawToken = crypto.randomBytes(40).toString('hex');
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const db = getDb();
  await db.refreshToken.create({
    data: { tokenHash, familyId, userId, expiresAt },
  });

  return rawToken;
}

/**
 * SHA-256 hash a string. Used for tokens and API keys.
 * @param {string} value
 * @returns {string} hex digest
 */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Generate a new API key in sk-cm-<hex> format.
 * Returns both the raw key (shown once) and the hash to store.
 * @returns {{ raw: string, hash: string, prefix: string }}
 */
function generateApiKey() {
  const raw = 'sk-cm-' + crypto.randomBytes(32).toString('hex');
  const hash = sha256(raw);
  const prefix = raw.substring(0, 14); // "sk-cm-" + first 8 chars
  return { raw, hash, prefix };
}

module.exports = {
  issueAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  generateApiKey,
  sha256,
};
