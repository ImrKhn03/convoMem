'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { QUEUES } = require('../jobs/queues');
const { getBoss } = require('../config/pgboss');
const memoryService = require('../services/memory.service');
const lookupService = require('../services/lookup.service');
const { getDb } = require('../config/db');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { parseIfString } = require('../utils/parse');

const captureSchema = z.object({
  messages: z.preprocess(
    parseIfString,
    z.array(z.object({ role: z.string(), content: z.string() })).min(1)
  ),
  platform: z.string().optional(),
  filters: z.preprocess(parseIfString, z.object({ pii: z.boolean().optional() }).optional()),
});

async function capture(req, res, next) {
  try {
    const input = captureSchema.parse(req.body);
    console.log(`Received capture request from user ${req.userId} with input:`, input);
    const captureId = crypto.randomUUID();
    const boss = await getBoss();
    await boss.send(QUEUES.CAPTURE, {
      userId: req.userId,
      captureId,
      messages: input.messages,
      opts: { platform: input.platform, filters: input.filters },
    }, { retryLimit: 3, retryDelay: 2, retryBackoff: true });
    res.status(202).json({ status: 'queued', captureId });
  } catch (err) {
    next(err);
  }
}

async function lookup(req, res, next) {
  try {
    const topicRaw = req.query.topic;
    if (!topicRaw) throw new ValidationError('topic query parameter is required');

    // Support pipe-separated multi-topic queries (e.g. "travel plans|location city")
    const topics = topicRaw.includes('|') ? topicRaw.split('|').map(t => t.trim()).filter(Boolean) : topicRaw;
    const result = await lookupService.lookup(req.userId, topics);

    // Log every lookup for analytics — fire-and-forget so it doesn't add latency
    const db = getDb();
    db.lookupLog.create({
      data: {
        userId: req.userId,
        topic: topicRaw,
        memoryIds: result.memories.map((m) => m.id),
        wasHelpful: null,
      },
    }).then((log) => {
      // Send lookupId back so the extension can attach feedback to this specific lookup
      res.json({ ...result, lookupId: log.id });
    }).catch(() => {
      // Log failure must not block the response
      res.json(result);
    });
  } catch (err) {
    next(err);
  }
}

const createSchema = z.object({
  content: z.string().min(1).max(5000),
  category: z.string().optional(),
  memoryType: z.enum(['fact', 'preference', 'decision', 'context', 'technical']).optional(),
  topicKey: z.string().optional(),
  platform: z.string().optional(),
});

const updateSchema = z.object({
  content: z.string().min(1).max(5000).optional(),
  category: z.string().optional(),
  memoryType: z.enum(['fact', 'preference', 'decision', 'context', 'technical']).optional(),
  topicKey: z.string().optional(),
});

async function create(req, res, next) {
  try {
    const input = createSchema.parse(req.body);
    const memory = await memoryService.createMemory(req.userId, input);
    res.status(201).json(memory);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const input = updateSchema.parse(req.body);
    if (Object.keys(input).length === 0) {
      throw new ValidationError('At least one field is required');
    }
    const memory = await memoryService.updateMemory(req.userId, req.params.id, input);
    res.json(memory);
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const category = req.query.category || undefined;
    const sort = req.query.sort || 'newest';
    const captureId = req.query.captureId || undefined;
    const result = await memoryService.listMemories(req.userId, { page, limit, category, sort, captureId });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function search(req, res, next) {
  try {
    const q = req.query.q;
    if (!q) throw new ValidationError('q query parameter is required');
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const results = await memoryService.searchMemories(req.userId, q, limit);
    res.json({ results, count: results.length });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const memory = await memoryService.getMemory(req.userId, req.params.id);
    res.json(memory);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await memoryService.deleteMemory(req.userId, req.params.id);
    res.json({ message: 'Memory deleted' });
  } catch (err) {
    next(err);
  }
}

async function lookupFeedback(req, res, next) {
  try {
    const { wasHelpful, topic, lookupId } = req.body;
    const memoryIds = parseIfString(req.body.memoryIds);
    const scores = parseIfString(req.body.scores);
    if (!Array.isArray(memoryIds)) throw new ValidationError('memoryIds must be an array');

    const db = getDb();

    if (lookupId) {
      // Update the existing lookup log row created during the lookup call
      await db.lookupLog.updateMany({
        where: { id: lookupId, userId: req.userId },
        data: { wasHelpful: wasHelpful ?? null },
      });
    } else {
      // Fallback: create a new row (legacy clients without lookupId)
      await db.lookupLog.create({
        data: {
          userId: req.userId,
          memoryIds,
          topic: topic || '',
          wasHelpful: wasHelpful ?? null,
        },
      });
    }

    // Apply importance boost/decay to the injected memories (fire-and-forget, non-blocking)
    if (typeof wasHelpful === 'boolean' && memoryIds.length > 0) {
      memoryService.applyFeedback(req.userId, memoryIds, wasHelpful, scores || {}).catch(() => {});
    }

    const action = wasHelpful === true ? 'boosted' : wasHelpful === false ? 'decayed' : 'logged';
    res.json({ message: 'Feedback recorded', action, count: memoryIds.length });
  } catch (err) {
    next(err);
  }
}

async function captureStatus(req, res, next) {
  try {
    const { captureId } = req.params;
    const db = getDb();
    const memories = await db.memory.findMany({
      where: { userId: req.userId, captureId },
      select: { id: true, content: true, category: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    if (memories.length > 0) {
      return res.json({ captureId, status: 'complete', count: memories.length, memories });
    }

    // No memories in DB — check CaptureResult for completed job (handles saved=0 / all skipped)
    try {
      const result = await db.captureResult.findUnique({ where: { captureId } });
      if (result) {
        return res.json({ captureId, status: 'complete', count: 0, memories: [], saved: result.saved, skipped: result.skipped });
      }
    } catch { /* non-fatal — fall through to pending */ }

    res.json({ captureId, status: 'pending', count: 0, memories: [] });
  } catch (err) {
    next(err);
  }
}

module.exports = { capture, captureStatus, lookup, list, search, getOne, remove, lookupFeedback, create, update };
