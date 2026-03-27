'use strict';

const { getRedis } = require('../config/redis');
const { AppError } = require('../utils/errors');

/**
 * Creates a Redis-backed rate limiter middleware.
 * @param {{ windowMs: number, max: number, keyPrefix?: string }} opts
 */
function createRateLimiter({ windowMs = 60_000, max = 60, keyPrefix = 'rl' } = {}) {
  return async function rateLimiter(req, res, next) {
    try {
      const redis = getRedis();
      const identifier = req.userId || req.ip;
      const key = `${keyPrefix}:${identifier}`;
      const windowSec = Math.ceil(windowMs / 1000);

      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSec);
      }

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - current));

      if (current > max) {
        const ttl = await redis.ttl(key);
        res.setHeader('Retry-After', ttl);
        throw new AppError('Too many requests', 429, 'RATE_LIMITED');
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

// Default rate limiter: 60 req/min per user/IP
const defaultRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

// Strict limiter for auth endpoints: 10 req/min
const authRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyPrefix: 'rl:auth' });

module.exports = { createRateLimiter, defaultRateLimiter, authRateLimiter };
