'use strict';

const { z } = require('zod');
const entityService = require('../services/entity.service');

const listSchema = z.object({
  type: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const searchSchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

async function list(req, res, next) {
  try {
    const { type, page, limit } = listSchema.parse(req.query);
    const result = await entityService.getEntities(req.userId, { page, limit, entityType: type });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function search(req, res, next) {
  try {
    const { q, limit } = searchSchema.parse(req.query);
    const entities = await entityService.searchEntities(req.userId, q, limit);
    res.json({ entities });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const entity = await entityService.getEntity(req.userId, req.params.id);
    if (!entity) return res.status(404).json({ error: 'Entity not found', code: 'NOT_FOUND' });
    res.json(entity);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const deleted = await entityService.deleteEntity(req.userId, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Entity not found', code: 'NOT_FOUND' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { list, search, getOne, remove };
