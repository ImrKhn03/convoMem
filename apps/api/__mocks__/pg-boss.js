'use strict';

// CJS-compatible pg-boss mock for Jest (pg-boss v10 is ESM-only and can't be required in Jest)
class PgBoss {
  async start() {}
  async stop() {}
  async work() {}
  async send() { return 'mock-job-id'; }
  async createQueue() {}
  on() { return this; }
}

module.exports = { PgBoss };
