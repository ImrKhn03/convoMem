'use strict';

/**
 * Memory API integration tests.
 * Mocks Qdrant and OpenAI to avoid external service dependencies.
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

// Mock BullMQ queue
jest.mock('../src/jobs/queues', () => ({
  QUEUES: {
    CAPTURE: 'memory-capture',
    WEBHOOK: 'webhook-delivery',
  },
}));

jest.mock('../src/config/pgboss', () => ({
  getBoss: jest.fn().mockResolvedValue({
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    createQueue: jest.fn(),
  }),
  stopBoss: jest.fn(),
}));

// Mock Qdrant
jest.mock('../src/config/qdrant', () => ({
  getQdrant: () => ({
    search: jest.fn().mockResolvedValue([
      {
        id: 'qdrant-id-1',
        score: 0.9,
        payload: {
          userId: 'test-user',
          content: 'User prefers TypeScript over JavaScript',
          category: 'preference',
          topicKey: 'language_preference',
          memoryType: 'preference',
          confidence: 0.9,
          importance: 0.8,
          isSensitive: false,
        },
      },
    ]),
    upsert: jest.fn().mockResolvedValue({ status: 'ok' }),
    delete: jest.fn().mockResolvedValue({ status: 'ok' }),
    getCollections: jest.fn().mockResolvedValue({ collections: [{ name: 'personal_memories' }] }),
    createCollection: jest.fn(),
    createPayloadIndex: jest.fn(),
  }),
  setupCollections: jest.fn().mockResolvedValue(undefined),
  PERSONAL_COLLECTION: 'personal_memories',
}));

// Mock OpenAI embeddings
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

describe('Memories API', () => {
  let db;
  let accessToken;
  let userId;
  const testEmail = `memory-test-${Date.now()}@example.com`;

  beforeAll(async () => {
    db = getDb();

    // Register and get a token
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: testEmail, password: 'Password123!', name: 'Memory Tester' });

    expect(res.status).toBe(201);
    accessToken = res.body.accessToken;
    userId = res.body.user.id;
  });

  afterAll(async () => {
    await db.memory.deleteMany({ where: { userId } }).catch(() => {});
    await db.user.deleteMany({ where: { email: testEmail } }).catch(() => {});
    await db.$disconnect();
  });

  describe('POST /api/memories/capture', () => {
    it('should queue a capture job', async () => {
      const res = await request(app)
        .post('/api/memories/capture')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          messages: [
            { role: 'user', content: 'I prefer TypeScript over JavaScript for large projects' },
            { role: 'assistant', content: 'Noted! TypeScript provides great type safety.' },
          ],
          platform: 'chatgpt',
        });

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('queued');
      expect(res.body).toHaveProperty('captureId');
    });

    it('should reject capture with no messages', async () => {
      const res = await request(app)
        .post('/api/memories/capture')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ messages: [] });

      expect(res.status).toBe(422);
    });

    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/memories/capture')
        .send({ messages: [{ role: 'user', content: 'test' }] });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/memories', () => {
    it('should return paginated memory list', async () => {
      const res = await request(app)
        .get('/api/memories')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('memories');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
      expect(Array.isArray(res.body.memories)).toBe(true);
    });
  });

  describe('GET /api/memories/lookup', () => {
    it('should return context for a given topic', async () => {
      const res = await request(app)
        .get('/api/memories/lookup?topic=programming+language+preferences')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('context');
      expect(res.body).toHaveProperty('memories');
    });

    it('should require topic parameter', async () => {
      const res = await request(app)
        .get('/api/memories/lookup')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/memories/search', () => {
    it('should perform semantic search', async () => {
      const res = await request(app)
        .get('/api/memories/search?q=programming')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('results');
      expect(res.body).toHaveProperty('count');
    });

    it('should require q parameter', async () => {
      const res = await request(app)
        .get('/api/memories/search')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(422);
    });
  });

  describe('POST /api/memories/lookup-feedback', () => {
    it('should record lookup feedback', async () => {
      const res = await request(app)
        .post('/api/memories/lookup-feedback')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ memoryIds: [], wasHelpful: true, topic: 'test topic' });

      expect(res.status).toBe(200);
    });
  });

});
