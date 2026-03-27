'use strict';

const crypto = require('crypto');
const { getQdrant, PERSONAL_COLLECTION } = require('../config/qdrant');
const { getDb } = require('../config/db');
const { getRedis } = require('../config/redis');
const OpenAI = require('openai');
const logger = require('../utils/logger');
const { NotFoundError } = require('../utils/errors');

/** @type {import('openai').OpenAI} */
let openaiClient;

function getOpenAI() {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

const MAX_EMBED_CHARS = 8000;

/** Strip internal infrastructure fields before returning memory objects to callers. */
function sanitize(memory) {
  if (!memory) return memory;
  const { qdrantId, ...rest } = memory;
  return rest;
}

/**
 * Get a text embedding from OpenAI.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function getEmbedding(text) {
  const openai = getOpenAI();
  const truncated = text.slice(0, MAX_EMBED_CHARS);
  const resp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: truncated,
  });
  return resp.data[0].embedding;
}

/**
 * Save a memory to Qdrant + Prisma and increment user's memoryCount.
 * @param {string} userId
 * @param {{ content: string, category?: string, topicKey?: string, memoryType?: string, durability?: number, confidence?: number, importance?: number, expiresAt?: Date, isSensitive?: boolean, sourceContext?: string }} fact
 * @returns {Promise<import('@prisma/client').Memory>}
 */
async function saveMemory(userId, fact) {
  const qdrant = getQdrant();
  const db = getDb();

  // Embed content + sourceContext together for richer semantic matching
  const embeddingText = fact.sourceContext
    ? `${fact.content} | Context: ${fact.sourceContext}`
    : fact.content;
  const embedding = await getEmbedding(embeddingText);
  const qdrantId = crypto.randomUUID();

  // Store in Qdrant
  await qdrant.upsert(PERSONAL_COLLECTION, {
    points: [
      {
        id: qdrantId,
        vector: embedding,
        payload: {
          userId,
          content: fact.content,
          sourceContext: fact.sourceContext || null,
          category: fact.category || null,
          topicKey: fact.topicKey || null,
          memoryType: fact.memoryType || 'fact',
          confidence: fact.confidence ?? 0.8,
          importance: fact.importance ?? 0.5,
          isSensitive: fact.isSensitive ?? false,
          searchTags: (fact.searchTags || []).join(' '),
        },
      },
    ],
  });

  // Store in Prisma
  const memory = await db.memory.create({
    data: {
      userId,
      qdrantId,
      content: fact.content,
      sourceContext: fact.sourceContext || null,
      category: fact.category || null,
      topicKey: fact.topicKey || null,
      memoryType: fact.memoryType || 'fact',
      durability: fact.durability ?? 0.5,
      confidence: fact.confidence ?? 0.8,
      importance: fact.importance ?? 0.5,
      isSensitive: fact.isSensitive ?? false,
      expiresAt: fact.expiresAt || null,
      platform: fact.platform || null,
      captureId: fact.captureId || null,
      searchTags: (fact.searchTags || []).join(' '),
    },
  });

  // Increment user memory count
  await db.user.update({
    where: { id: userId },
    data: { memoryCount: { increment: 1 } },
  });

  // Invalidate lookup cache for this user — new memory must be visible immediately
  try {
    const redis = getRedis();
    const pattern = `lookup:${userId}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  } catch { /* non-fatal — cache will expire naturally */ }

  logger.debug({ userId, memoryId: memory.id }, 'Memory saved');
  return sanitize(memory);
}

/**
 * Search memories by semantic similarity.
 * ALWAYS filters by userId for tenant isolation.
 * @param {string} userId
 * @param {string} query
 * @param {number} [limit=30]
 * @returns {Promise<Array>}
 */
async function searchMemories(userId, query, limit = 30) {
  const qdrant = getQdrant();
  const embedding = await getEmbedding(query);

  const results = await qdrant.search(PERSONAL_COLLECTION, {
    vector: embedding,
    limit,
    filter: {
      must: [{ key: 'userId', match: { value: userId } }],
    },
    with_payload: true,
  });

  return results;
}

/**
 * Delete a memory by ID.
 * @param {string} userId
 * @param {string} memoryId  Prisma memory ID
 */
async function deleteMemory(userId, memoryId) {
  const db = getDb();

  const memory = await db.memory.findFirst({ where: { id: memoryId, userId } });
  if (!memory) throw new NotFoundError('Memory not found');

  // Delete from Qdrant
  const qdrant = getQdrant();
  await qdrant.delete(PERSONAL_COLLECTION, { points: [memory.qdrantId] });

  // Delete from Prisma
  await db.memory.delete({ where: { id: memoryId } });

  // Decrement count
  await db.user.update({
    where: { id: userId },
    data: { memoryCount: { decrement: 1 } },
  });

  logger.debug({ userId, memoryId }, 'Memory deleted');
}

/**
 * Manually create a memory for a user.
 * @param {string} userId
 * @param {{ content: string, category?: string, memoryType?: string, topicKey?: string, platform?: string, sourceContext?: string }} data
 * @returns {Promise<import('@prisma/client').Memory>}
 */
async function createMemory(userId, data) {
  const db = getDb();

  const embeddingText = data.sourceContext
    ? `${data.content} | Context: ${data.sourceContext}`
    : data.content;
  const embedding = await getEmbedding(embeddingText);
  const qdrantId = crypto.randomUUID();

  const qdrant = getQdrant();
  await qdrant.upsert(PERSONAL_COLLECTION, {
    points: [
      {
        id: qdrantId,
        vector: embedding,
        payload: {
          userId,
          content: data.content,
          sourceContext: data.sourceContext || null,
          category: data.category || null,
          topicKey: data.topicKey || null,
          memoryType: data.memoryType || 'fact',
          confidence: 0.9,
          importance: 0.7,
          isSensitive: false,
        },
      },
    ],
  });

  const memory = await db.memory.create({
    data: {
      userId,
      qdrantId,
      content: data.content,
      sourceContext: data.sourceContext || null,
      category: data.category || null,
      topicKey: data.topicKey || null,
      memoryType: data.memoryType || 'fact',
      platform: data.platform || null,
      durability: 0.7,
      confidence: 0.9,
      importance: 0.7,
      isSensitive: false,
    },
  });

  await db.user.update({
    where: { id: userId },
    data: { memoryCount: { increment: 1 } },
  });

  logger.debug({ userId, memoryId: memory.id }, 'Memory created (manual)');
  return sanitize(memory);
}

/**
 * Update an existing memory.
 * @param {string} userId
 * @param {string} memoryId
 * @param {{ content?: string, category?: string, memoryType?: string, topicKey?: string, sourceContext?: string }} data
 * @returns {Promise<import('@prisma/client').Memory>}
 */
async function updateMemory(userId, memoryId, data) {
  const db = getDb();

  const existing = await db.memory.findFirst({ where: { id: memoryId, userId } });
  if (!existing) throw new NotFoundError('Memory not found');

  const updateData = { updatedAt: new Date() };
  if (data.category !== undefined) updateData.category = data.category;
  if (data.memoryType !== undefined) updateData.memoryType = data.memoryType;
  if (data.topicKey !== undefined) updateData.topicKey = data.topicKey;

  if (data.sourceContext !== undefined) updateData.sourceContext = data.sourceContext;

  if (data.content !== undefined && data.content !== existing.content) {
    updateData.content = data.content;
    const ctx = data.sourceContext !== undefined ? data.sourceContext : existing.sourceContext;
    const embeddingText = ctx ? `${data.content} | Context: ${ctx}` : data.content;
    const embedding = await getEmbedding(embeddingText);
    const qdrant = getQdrant();
    await qdrant.upsert(PERSONAL_COLLECTION, {
      points: [
        {
          id: existing.qdrantId,
          vector: embedding,
          payload: {
            userId,
            content: data.content,
            sourceContext: ctx || null,
            category: data.category !== undefined ? data.category : existing.category,
            topicKey: data.topicKey !== undefined ? data.topicKey : existing.topicKey,
            memoryType: data.memoryType !== undefined ? data.memoryType : existing.memoryType,
            confidence: existing.confidence,
            importance: existing.importance,
            isSensitive: existing.isSensitive,
          },
        },
      ],
    });
  }

  const memory = await db.memory.update({
    where: { id: memoryId },
    data: updateData,
  });

  logger.debug({ userId, memoryId }, 'Memory updated');
  return sanitize(memory);
}

/**
 * List memories for a user (paginated, filterable, sortable).
 * @param {string} userId
 * @param {{ page?: number, limit?: number, category?: string, sort?: string }} opts
 */
async function listMemories(userId, { page = 1, limit = 20, category, sort = 'newest', captureId } = {}) {
  const db = getDb();
  const skip = (page - 1) * limit;

  const where = { userId, supersededById: null };
  if (category) {
    where.category = { equals: category, mode: 'insensitive' };
  }
  if (captureId) {
    where.captureId = captureId;
  }

  const sortMap = {
    newest: { createdAt: 'desc' },
    oldest: { createdAt: 'asc' },
    confidence: { confidence: 'desc' },
  };
  const orderBy = sortMap[sort] || sortMap.newest;

  const [total, memories] = await Promise.all([
    db.memory.count({ where }),
    db.memory.findMany({
      where,
      orderBy,
      skip,
      take: limit,
    }),
  ]);

  return { memories: memories.map(sanitize), total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * Get a single memory by ID.
 * @param {string} userId
 * @param {string} memoryId
 */
async function getMemory(userId, memoryId) {
  const db = getDb();
  const memory = await db.memory.findFirst({ where: { id: memoryId, userId } });
  if (!memory) throw new NotFoundError('Memory not found');
  return sanitize(memory);
}

/**
 * Apply helpfulness feedback to a set of memories, adjusting their importance
 * scores in both Prisma and Qdrant so future lookups reflect the signal.
 *
 * When relevance scores are provided, the feedback delta is weighted by how
 * relevant the memory was to the query — strong matches get larger adjustments,
 * weak matches get smaller ones. This prevents a barely-relevant memory from
 * getting the same boost as a perfect match.
 *
 * Base deltas: helpful +0.05, unhelpful -0.08
 * Weighted:   delta × clamp(relevanceScore, 0.3, 1.0)
 *
 * @param {string}   userId
 * @param {string[]} memoryIds   Prisma memory IDs from the lookup response
 * @param {boolean|null} wasHelpful
 * @param {Object<string, number>} [scores]  Optional map of memoryId → relevanceScore (0-1)
 */
async function applyFeedback(userId, memoryIds, wasHelpful, scores = {}) {
  if (!memoryIds || memoryIds.length === 0 || wasHelpful === null || wasHelpful === undefined) return;

  const db = getDb();
  const qdrant = getQdrant();

  const memories = await db.memory.findMany({
    where: { id: { in: memoryIds }, userId },
    select: { id: true, qdrantId: true, importance: true },
  });

  if (memories.length === 0) return;

  await Promise.all(
    memories.map(async (memory) => {
      const baseDelta = wasHelpful ? 0.05 : -0.08;
      // Weight by relevance score — clamp to [0.3, 1.0] so even unscored memories get meaningful feedback
      const relevance = scores[memory.id] != null ? Math.max(0.3, Math.min(1.0, scores[memory.id])) : 0.5;
      const delta = baseDelta * relevance;
      const newImportance = wasHelpful
        ? Math.min(1.0, memory.importance + delta)
        : Math.max(0.1, memory.importance + delta); // delta is already negative for unhelpful

      const prismaData = { importance: newImportance };
      if (wasHelpful) {
        prismaData.confirmationCount = { increment: 1 };
        prismaData.lastConfirmedAt = new Date();
      }

      await db.memory.update({ where: { id: memory.id }, data: prismaData });

      // Sync importance into Qdrant payload so the scoring formula picks it up immediately
      await qdrant.setPayload(PERSONAL_COLLECTION, {
        payload: { importance: newImportance },
        points: [memory.qdrantId],
      });

      logger.info(
        { memoryId: memory.id, oldImportance: memory.importance, newImportance, relevance, delta: delta.toFixed(4) },
        'Weighted feedback applied'
      );
    })
  );

  logger.info({ userId, count: memories.length, wasHelpful, hasScores: Object.keys(scores).length > 0, scores}, 'Feedback applied to memories');
}

module.exports = { getEmbedding, saveMemory, searchMemories, deleteMemory, listMemories, getMemory, createMemory, updateMemory, applyFeedback };
