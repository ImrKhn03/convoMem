'use strict';

/**
 * Stats and Integrations API tests.
 */

const request = require('supertest');
const app = require('../src/app');
const { getDb } = require('../src/config/db');

jest.mock('../src/config/redis', () => ({
  getRedis: () => ({
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(60),
    on: jest.fn(),
    pipeline: jest.fn(() => ({ exec: jest.fn().mockResolvedValue([[null, 0], [null, null], [null, 1], [null, 1]]) })),
    zremrangebyscore: jest.fn(),
    zadd: jest.fn(),
    zcard: jest.fn(),
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

describe('Stats API', () => {
  let db;
  let accessToken;
  let userId;
  const testEmail = `stats-${Date.now()}@example.com`;

  beforeAll(async () => {
    db = getDb();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: testEmail, password: 'Password123!', name: 'Stats User' });
    expect(res.status).toBe(201);
    accessToken = res.body.accessToken;
    userId = res.body.user.id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await db.$disconnect();
  });

  describe('GET /api/stats/dashboard', () => {
    it('returns dashboard stats with correct shape', async () => {
      const res = await request(app)
        .get('/api/stats')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalMemories');
      expect(res.body).toHaveProperty('hitRate');
      expect(res.body).toHaveProperty('aiSessions');
      expect(res.body).toHaveProperty('integrationsCount');
      expect(res.body).toHaveProperty('memoriesByCategory');
      expect(res.body).toHaveProperty('memoryGrowth');
      expect(Array.isArray(res.body.memoryGrowth)).toBe(true);
    });

    it('totalMemories starts at 0 for new user', async () => {
      const res = await request(app)
        .get('/api/stats')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.totalMemories).toBe(0);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(401);
    });
  });
});

describe('Integrations API', () => {
  let db;
  let accessToken;
  let userId;
  const testEmail = `integrations-${Date.now()}@example.com`;

  beforeAll(async () => {
    db = getDb();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: testEmail, password: 'Password123!', name: 'Integrations User' });
    expect(res.status).toBe(201);
    accessToken = res.body.accessToken;
    userId = res.body.user.id;
  });

  afterAll(async () => {
    await db.integration.deleteMany({ where: { userId } }).catch(() => {});
    await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await db.$disconnect();
  });

  describe('GET /api/integrations', () => {
    it('returns all supported platforms', async () => {
      const res = await request(app)
        .get('/api/integrations')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.integrations)).toBe(true);

      const platforms = res.body.integrations.map((i) => i.platform);
      expect(platforms).toContain('cursor');
      expect(platforms).toContain('claude');
      expect(platforms).toContain('chatgpt');
    });

    it('all platforms start inactive for new user', async () => {
      const res = await request(app)
        .get('/api/integrations')
        .set('Authorization', `Bearer ${accessToken}`);

      const active = res.body.integrations.filter((i) => i.isActive);
      expect(active).toHaveLength(0);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/integrations');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/integrations/:platform', () => {
    it('activates an integration', async () => {
      const res = await request(app)
        .patch('/api/integrations/cursor')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ isActive: true });

      expect(res.status).toBe(200);
      expect(res.body.integration.isActive).toBe(true);
      expect(res.body.integration.platform).toBe('cursor');
    });

    it('deactivates an integration', async () => {
      const res = await request(app)
        .patch('/api/integrations/cursor')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ isActive: false });

      expect(res.status).toBe(200);
      expect(res.body.integration.isActive).toBe(false);
    });

    it('rejects unsupported platform', async () => {
      const res = await request(app)
        .patch('/api/integrations/unknown-platform')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ isActive: true });

      expect(res.status).toBe(422);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .patch('/api/integrations/cursor')
        .send({ isActive: true });

      expect(res.status).toBe(401);
    });
  });
});
