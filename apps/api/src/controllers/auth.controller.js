'use strict';

const { z } = require('zod');
const authService = require('../services/auth.service');
const { ValidationError } = require('../utils/errors');

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function register(req, res, next) {
  try {
    const input = registerSchema.parse(req.body);
    const result = await authService.register(input.email, input.password, input.name);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input.email, input.password);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new ValidationError('refreshToken is required');
    const result = await authService.refresh(refreshToken);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) await authService.logout(refreshToken);
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}

async function createApiKey(req, res, next) {
  try {
    const { name } = req.body;
    if (!name) throw new ValidationError('name is required');
    const result = await authService.createApiKey(req.userId, name);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

async function listApiKeys(req, res, next) {
  try {
    const keys = await authService.listApiKeys(req.userId);
    res.json({ keys });
  } catch (err) {
    next(err);
  }
}

async function deleteApiKey(req, res, next) {
  try {
    await authService.deleteApiKey(req.userId, req.params.keyId);
    res.json({ message: 'API key deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, refresh, logout, createApiKey, listApiKeys, deleteApiKey };
