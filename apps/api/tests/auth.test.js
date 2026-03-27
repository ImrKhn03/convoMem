'use strict';

/**
 * Auth integration tests.
 * Requires a running PostgreSQL instance pointed to by DATABASE_URL.
 * Set NODE_ENV=test and provide test env vars before running.
 */

const request = require('supertest');
const app = require('../src/app');
const { getDb } = require('../src/config/db');

// Mock external dependencies to keep tests fast and isolated
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

jest.mock('../src/jobs/queues', () => ({
  captureQueue: {
    add: jest.fn().mockResolvedValue({ id: 'test-job-id' }),
  },
  connection: {},
}));

describe('Auth API', () => {
  let db;
  const testEmail = `test-${Date.now()}@example.com`;
  const testPassword = 'Password123!';
  let refreshToken;
  let accessToken;

  beforeAll(async () => {
    db = getDb();
  });

  afterAll(async () => {
    // Cleanup test user
    await db.user.deleteMany({ where: { email: testEmail } }).catch(() => {});
    await db.$disconnect();
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: testEmail, password: testPassword, name: 'Test User' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
      expect(res.body.user).toMatchObject({ email: testEmail });

      refreshToken = res.body.refreshToken;
      accessToken = res.body.accessToken;
    });

    it('should reject duplicate email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: testEmail, password: testPassword });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
    });

    it('should reject short password', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'other@example.com', password: 'short' });

      expect(res.status).toBe(422);
    });

    it('should reject invalid email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'not-an-email', password: testPassword });

      expect(res.status).toBe(422);
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login with valid credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: testEmail, password: testPassword });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
      refreshToken = res.body.refreshToken;
      accessToken = res.body.accessToken;
    });

    it('should reject wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: testEmail, password: 'wrongpassword' });

      expect(res.status).toBe(401);
    });

    it('should reject unknown email', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: testPassword });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('should issue new tokens with valid refresh token', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
      // Update tokens for subsequent tests
      refreshToken = res.body.refreshToken;
      accessToken = res.body.accessToken;
    });

    it('should reject already-used refresh token (reuse detection)', async () => {
      // Capture the old refreshToken before rotating
      const oldToken = refreshToken;

      // Rotate once
      const rotateRes = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: oldToken });
      expect(rotateRes.status).toBe(200);
      refreshToken = rotateRes.body.refreshToken;

      // Attempt reuse of old token — should fail
      const reuseRes = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: oldToken });

      expect(reuseRes.status).toBe(401);
    });

    it('should reject invalid refresh token', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'invalid-token-garbage' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should log out successfully', async () => {
      const res = await request(app)
        .post('/api/auth/logout')
        .send({ refreshToken });

      expect(res.status).toBe(200);
    });

    it('should return 200 even with no token (idempotent)', async () => {
      const res = await request(app)
        .post('/api/auth/logout')
        .send({});

      expect(res.status).toBe(200);
    });
  });

  describe('Protected routes', () => {
    it('should reject requests without auth header', async () => {
      const res = await request(app).get('/api/memories');
      expect(res.status).toBe(401);
    });

    it('should reject requests with invalid JWT', async () => {
      const res = await request(app)
        .get('/api/memories')
        .set('Authorization', 'Bearer invalid.jwt.token');
      expect(res.status).toBe(401);
    });
  });
});
