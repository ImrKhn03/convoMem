'use strict';

const { PrismaClient } = require('@prisma/client');

/** @type {PrismaClient} */
let prisma;

/**
 * Returns the Prisma singleton client.
 * @returns {PrismaClient}
 */
function getDb() {
  if (!prisma) {
    prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });
  }
  return prisma;
}

module.exports = { getDb };
