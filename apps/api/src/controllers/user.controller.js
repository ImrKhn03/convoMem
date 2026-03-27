'use strict';

const { z } = require('zod');
const bcrypt = require('bcrypt');
const { getDb } = require('../config/db');
const { ValidationError, NotFoundError, AuthError, ConflictError } = require('../utils/errors');

const BCRYPT_ROUNDS = 12;

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
}).refine((d) => d.name !== undefined || d.email !== undefined, {
  message: 'At least one of name or email is required',
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

async function getProfile(req, res, next) {
  try {
    const db = getDb();
    const user = await db.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, name: true, memoryCount: true, createdAt: true },
    });
    if (!user) throw new NotFoundError('User not found');
    res.json(user);
  } catch (err) {
    next(err);
  }
}

async function updateProfile(req, res, next) {
  try {
    const input = updateProfileSchema.parse(req.body);
    const db = getDb();

    // If changing email, check it isn't already taken
    if (input.email) {
      const existing = await db.user.findFirst({
        where: { email: input.email.toLowerCase(), NOT: { id: req.userId } },
      });
      if (existing) throw new ConflictError('Email already in use');
      input.email = input.email.toLowerCase();
    }

    const user = await db.user.update({
      where: { id: req.userId },
      data: input,
      select: { id: true, email: true, name: true, memoryCount: true, createdAt: true },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
}

async function changePassword(req, res, next) {
  try {
    const input = changePasswordSchema.parse(req.body);
    const db = getDb();

    const user = await db.user.findUnique({
      where: { id: req.userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new NotFoundError('User not found');

    const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!valid) throw new AuthError('Current password is incorrect');

    if (input.newPassword === input.currentPassword) {
      throw new ValidationError('New password must be different from current password');
    }

    const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
    await db.user.update({ where: { id: req.userId }, data: { passwordHash } });

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getProfile, updateProfile, changePassword };
