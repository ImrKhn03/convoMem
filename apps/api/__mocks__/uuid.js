'use strict';

// CJS-compatible uuid mock for Jest (uuid v13 is ESM-only)
const { randomUUID } = require('crypto');

module.exports = {
  v4: randomUUID,
  v1: randomUUID,
  v7: randomUUID,
};
