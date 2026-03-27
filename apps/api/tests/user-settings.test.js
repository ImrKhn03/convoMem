'use strict';

/**
 * User settings integration tests.
 * Covers GET/PATCH /api/user/profile and POST /api/user/change-password.
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

jest.mock('../src/jobs/queues', () => ({
  captureQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job' }) },
  webhookQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-wh-job' }) },
  connection: {},
}));

describe('User Settings API', () => {
  let db;
  let accessToken;
  let userId;
  const testEmail = `settings-${Date.now()}@example.com`;
  const password = 'Password123!';

  beforeAll(async () => {
    db = getDb();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: testEmail, password, name: 'Settings User' });
    expect(res.status).toBe(201);
    accessToken = res.body.accessToken;
    userId = res.body.user.id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await db.$disconnect();
  });

  describe('GET /api/user/profile', () => {
    it('returns the current user profile', async () => {
      const res = await request(app)
        .get('/api/user/profile')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(testEmail);
      expect(res.body.name).toBe('Settings User');
      expect(res.body).toHaveProperty('memoryCount');
      expect(res.body).toHaveProperty('createdAt');
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/user/profile');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/user/profile', () => {
    it('updates the user name', async () => {
      const res = await request(app)
        .patch('/api/user/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Imran Updated' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Imran Updated');
    });

    it('updates the user email', async () => {
      const newEmail = `settings-updated-${Date.now()}@example.com`;
      const res = await request(app)
        .patch('/api/user/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ email: newEmail });

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(newEmail);

      // Restore original email for subsequent tests
      await db.user.update({ where: { id: userId }, data: { email: testEmail } });
    });

    it('rejects update with no fields', async () => {
      const res = await request(app)
        .patch('/api/user/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(422);
    });

    it('rejects duplicate email (already used by another user)', async () => {
      // Create a second user
      const otherEmail = `settings-other-${Date.now()}@example.com`;
      await request(app)
        .post('/api/auth/register')
        .send({ email: otherEmail, password, name: 'Other' });

      const res = await request(app)
        .patch('/api/user/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ email: otherEmail });

      expect(res.status).toBe(409);

      await db.user.deleteMany({ where: { email: otherEmail } }).catch(() => {});
    });

    it('rejects invalid email format', async () => {
      const res = await request(app)
        .patch('/api/user/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(422);
    });
  });

  describe('POST /api/user/change-password', () => {
    it('changes password with correct current password', async () => {
      const res = await request(app)
        .post('/api/user/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: password, newPassword: 'NewPassword456!' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Password updated successfully');

      // Verify login works with new password
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: testEmail, password: 'NewPassword456!' });
      expect(loginRes.status).toBe(200);

      // Restore original password
      await request(app)
        .post('/api/user/change-password')
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
        .send({ currentPassword: 'NewPassword456!', newPassword: password });
    });

    it('rejects wrong current password', async () => {
      const res = await request(app)
        .post('/api/user/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'wrongpassword', newPassword: 'NewPassword456!' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects new password same as current', async () => {
      const res = await request(app)
        .post('/api/user/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: password, newPassword: password });

      expect(res.status).toBe(422);
    });

    it('rejects new password shorter than 8 characters', async () => {
      const res = await request(app)
        .post('/api/user/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: password, newPassword: 'short' });

      expect(res.status).toBe(422);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/user/change-password')
        .send({ currentPassword: password, newPassword: 'NewPassword456!' });

      expect(res.status).toBe(401);
    });
  });
});
