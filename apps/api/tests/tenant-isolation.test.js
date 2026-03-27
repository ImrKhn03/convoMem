'use strict';

/**
 * Tenant isolation tests.
 * Verifies that user A cannot access user B's memories.
 * This is a critical security requirement.
 */

const request = require('supertest');
const app = require('../src/app');
const { getDb } = require('../src/config/db');

// Mock Redis
jest.mock('../src/config/redis', () => ({
  getRedis: () => ({
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(60),
    on: jest.fn(),
  }),
}));

jest.mock('../src/config/pgboss', () => ({
  getBoss: jest.fn().mockResolvedValue({
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    createQueue: jest.fn(),
  }),
  stopBoss: jest.fn(),
}));

// Mock Qdrant — user-scoped
jest.mock('../src/config/qdrant', () => {
  const PERSONAL_COLLECTION = 'personal_memories';
  return {
    getQdrant: () => ({
      search: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({ status: 'ok' }),
      delete: jest.fn().mockResolvedValue({ status: 'ok' }),
      getCollections: jest.fn().mockResolvedValue({ collections: [{ name: PERSONAL_COLLECTION }] }),
      createCollection: jest.fn(),
      createPayloadIndex: jest.fn(),
    }),
    setupCollections: jest.fn().mockResolvedValue(undefined),
    PERSONAL_COLLECTION,
  };
});

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    embeddings: {
      create: jest.fn().mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0.1) }],
      }),
    },
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: '[]' } }],
        }),
      },
    },
  }));
});

describe('Tenant Isolation', () => {
  let db;
  let userAToken;
  let userBToken;
  let userAId;
  let userBId;
  let userAMemoryId;

  const emailA = `tenant-a-${Date.now()}@example.com`;
  const emailB = `tenant-b-${Date.now()}@example.com`;
  const password = 'Password123!';

  beforeAll(async () => {
    db = getDb();

    // Register user A
    const resA = await request(app)
      .post('/api/auth/register')
      .send({ email: emailA, password, name: 'User A' });
    expect(resA.status).toBe(201);
    userAToken = resA.body.accessToken;
    userAId = resA.body.user.id;

    // Register user B
    const resB = await request(app)
      .post('/api/auth/register')
      .send({ email: emailB, password, name: 'User B' });
    expect(resB.status).toBe(201);
    userBToken = resB.body.accessToken;
    userBId = resB.body.user.id;

    // Create a memory directly for user A via DB + mocked Qdrant
    const memory = await db.memory.create({
      data: {
        userId: userAId,
        qdrantId: `qdrant-isolation-test-${Date.now()}`,
        content: 'User A secret preference',
        topicKey: 'secret_pref',
        memoryType: 'preference',
        durability: 0.9,
        confidence: 0.9,
        importance: 0.8,
      },
    });
    userAMemoryId = memory.id;
    await db.user.update({ where: { id: userAId }, data: { memoryCount: { increment: 1 } } });
  });

  afterAll(async () => {
    await db.memory.deleteMany({ where: { userId: { in: [userAId, userBId] } } }).catch(() => {});
    await db.user.deleteMany({ where: { email: { in: [emailA, emailB] } } }).catch(() => {});
    await db.$disconnect();
  });

  it("user B cannot GET user A's memory by ID", async () => {
    const res = await request(app)
      .get(`/api/memories/${userAMemoryId}`)
      .set('Authorization', `Bearer ${userBToken}`);

    // Must be 404 (not found for that user) — not a 200 with A's data
    expect(res.status).toBe(404);
  });

  it("user B cannot DELETE user A's memory", async () => {
    const res = await request(app)
      .delete(`/api/memories/${userAMemoryId}`)
      .set('Authorization', `Bearer ${userBToken}`);

    expect(res.status).toBe(404);

    // Verify memory still exists for user A
    const memory = await db.memory.findFirst({
      where: { id: userAMemoryId, userId: userAId },
    });
    expect(memory).not.toBeNull();
  });

  it("user A's memory list does not contain user B's memories", async () => {
    // Create a memory for user B
    await db.memory.create({
      data: {
        userId: userBId,
        qdrantId: `qdrant-b-test-${Date.now()}`,
        content: 'User B private data',
        topicKey: 'b_private',
        memoryType: 'fact',
        durability: 0.7,
        confidence: 0.8,
        importance: 0.5,
      },
    });

    const res = await request(app)
      .get('/api/memories')
      .set('Authorization', `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    const contents = res.body.memories.map((m) => m.content);
    expect(contents).not.toContain('User B private data');
  });

  it('unauthenticated request to any memory endpoint returns 401', async () => {
    const res = await request(app).get(`/api/memories/${userAMemoryId}`);
    expect(res.status).toBe(401);
  });
});
