'use strict';

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getDb } = require('../config/db');
const {
  issueAccessToken,
  issueRefreshToken,
  generateApiKey,
  sha256,
} = require('../utils/tokens');
const { AuthError, ConflictError, NotFoundError } = require('../utils/errors');

const BCRYPT_ROUNDS = 12;

/**
 * Register a new user.
 * @param {string} email
 * @param {string} password
 * @param {string} [name]
 */
async function register(email, password, name) {
  const db = getDb();

  const existing = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) throw new ConflictError('Email already registered');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await db.user.create({
    data: { email: email.toLowerCase(), passwordHash, name },
    select: { id: true, email: true, name: true },
  });

  const familyId = crypto.randomUUID();
  const accessToken = issueAccessToken(user.id, user.email);
  const refreshToken = await issueRefreshToken(user.id, familyId);

  return { user, accessToken, refreshToken };
}

/**
 * Login with email + password.
 * @param {string} email
 * @param {string} password
 */
async function login(email, password) {
  const db = getDb();

  const user = await db.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true, name: true, passwordHash: true },
  });

  if (!user) throw new AuthError('Invalid credentials');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new AuthError('Invalid credentials');

  const familyId = crypto.randomUUID();
  const accessToken = issueAccessToken(user.id, user.email);
  const refreshToken = await issueRefreshToken(user.id, familyId);

  const { passwordHash: _, ...safeUser } = user;
  return { user: safeUser, accessToken, refreshToken };
}

/**
 * Rotate a refresh token. Detects family reuse (token theft).
 * @param {string} rawToken
 */
async function refresh(rawToken) {
  const db = getDb();
  const tokenHash = sha256(rawToken);

  const stored = await db.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true } } },
  });

  if (!stored) throw new AuthError('Invalid refresh token');
  if (stored.expiresAt < new Date()) throw new AuthError('Refresh token expired');

  // Reuse detection: if already used, invalidate the whole family
  if (stored.used) {
    await db.refreshToken.deleteMany({ where: { familyId: stored.familyId } });
    throw new AuthError('Refresh token reuse detected — please log in again');
  }

  // Mark current token as used
  await db.refreshToken.update({ where: { id: stored.id }, data: { used: true } });

  // Issue new token in the same family
  const accessToken = issueAccessToken(stored.user.id, stored.user.email);
  const newRefreshToken = await issueRefreshToken(stored.user.id, stored.familyId);

  return { accessToken, refreshToken: newRefreshToken, user: stored.user };
}

/**
 * Revoke a refresh token (logout).
 * @param {string} rawToken
 */
async function logout(rawToken) {
  const db = getDb();
  const tokenHash = sha256(rawToken);
  await db.refreshToken.deleteMany({ where: { tokenHash } });
}

/**
 * Create an API key for a user.
 * Returns the raw key once — only the hash is stored.
 * @param {string} userId
 * @param {string} name
 */
async function createApiKey(userId, name) {
  const db = getDb();

  // Check user exists
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User not found');

  const { raw, hash, prefix } = generateApiKey();
  await db.apiKey.create({
    data: { userId, name, keyHash: hash, keyPrefix: prefix },
  });

  return { key: raw, prefix, name };
}

/**
 * List API keys for a user (without revealing hashes).
 * @param {string} userId
 */
async function listApiKeys(userId) {
  const db = getDb();
  return db.apiKey.findMany({
    where: { userId },
    select: { id: true, name: true, keyPrefix: true, lastUsed: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Delete an API key.
 * @param {string} userId
 * @param {string} keyId
 */
async function deleteApiKey(userId, keyId) {
  const db = getDb();
  const key = await db.apiKey.findFirst({ where: { id: keyId, userId } });
  if (!key) throw new NotFoundError('API key not found');
  await db.apiKey.delete({ where: { id: keyId } });
}

module.exports = { register, login, refresh, logout, createApiKey, listApiKeys, deleteApiKey };
