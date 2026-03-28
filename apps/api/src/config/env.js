'use strict';

const REQUIRED = [
  'DATABASE_URL',
  'QDRANT_URL',
  'OPENAI_API_KEY',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
];

const OPTIONAL = [
  'REDIS_URL',
];

const REQUIRED_PROD = [
  'APP_URL',
];

/**
 * Validate required environment variables on startup.
 * Throws if any are missing so the process fails fast.
 */
function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);

  if (process.env.NODE_ENV === 'production') {
    missing.push(...REQUIRED_PROD.filter((key) => !process.env[key]));
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = { validateEnv };
