'use strict';

const crypto = require('crypto');
const { getQdrant, PERSONAL_COLLECTION } = require('../config/qdrant');
const { getDb } = require('../config/db');
const { getEmbedding } = require('./memory.service');
const { getRedis } = require('../config/redis');
const logger = require('../utils/logger');

const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can','could',
  'i','me','my','mine','we','us','our','you','your','he','him','his','she','her',
  'it','its','they','them','their','what','which','who','whom','this','that','these',
  'those','am','of','in','to','for','with','on','at','by','from','as','into','about',
  'between','through','during','before','after','above','below','up','down','out','off',
  'over','under','again','further','then','once','here','there','when','where','why','how',
  'all','each','every','both','few','more','most','other','some','such','no','nor','not',
  'only','own','same','so','than','too','very','just','because','but','and','or','if',
  'while','help','tell','know','find','get','give','make','want','need','like','think',
  'near','things','something','anything',
  'user','users','prefer','prefers','preferences','preferred',
  'currently','really','always','never','personal','recommend','suggest',
]);

function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

const LOOKUP_CACHE_TTL = 30;
const EMBED_CACHE_TTL  = 3600;
const MIN_SCORE = 0.30;
const MAX_MEMORIES = 10;
const MAX_TOKENS = 800;

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

async function getCachedEmbedding(text) {
  const redis = getRedis();
  const key = `emb:${crypto.createHash('sha256').update(text).digest('hex')}`;

  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
  } catch { /* Redis unavailable */ }

  const vector = await getEmbedding(text);

  try {
    await redis.setex(key, EMBED_CACHE_TTL, JSON.stringify(vector));
  } catch { /* non-fatal */ }

  return vector;
}

/**
 * Inject relevant memories for a given topic.
 *
 * Open-source version: uses Qdrant similarity score directly for ranking.
 * The full version uses a composite formula with recency decay and priority thresholds.
 */
async function lookup(userId, topics, opts = {}) {
  const db = getDb();
  const qdrant = getQdrant();
  const redis = getRedis();

  const topicString = Array.isArray(topics) ? topics.join('|') : topics;
  const cacheKey = `lookup:${userId}:${crypto.createHash('sha256').update(topicString).digest('hex')}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.debug({ userId, cacheKey }, 'Lookup cache hit');
      return JSON.parse(cached);
    }
  } catch { /* Redis unavailable */ }

  const topicList = Array.isArray(topics) ? topics : [topics];
  const allResults = [];
  const seenIds = new Set();

  await Promise.all(
    topicList.map(async (topic) => {
      try {
        const embedding = await getCachedEmbedding(topic);
        const results = await qdrant.search(PERSONAL_COLLECTION, {
          vector: embedding,
          limit: 20,
          filter: {
            must: [
              { key: 'userId', match: { value: userId } },
              { key: 'isSensitive', match: { value: false } },
            ],
          },
          with_payload: true,
        });

        for (const r of results) {
          if (!seenIds.has(r.id)) {
            seenIds.add(r.id);
            allResults.push(r);
          }
        }
      } catch (err) {
        logger.error({ err, topic }, 'Lookup search failed for sub-topic');
      }
    })
  );

  // Keyword fallback when vector search underperforms
  const vectorHits = allResults.filter((r) => r.score >= MIN_SCORE).length;
  if (vectorHits < 3) {
    const keywords = extractKeywords(topicString);
    if (keywords.length > 0) {
      try {
        const keywordResults = await qdrant.scroll(PERSONAL_COLLECTION, {
          filter: {
            must: [
              { key: 'userId', match: { value: userId } },
              { key: 'isSensitive', match: { value: false } },
            ],
            should: [
              { key: 'content', match: { text: keywords.join(' ') } },
              { key: 'topicKey', match: { text: keywords.join(' ') } },
              { key: 'searchTags', match: { text: keywords.join(' ') } },
            ],
          },
          limit: 10,
          with_payload: true,
        });
        for (const point of keywordResults.points || []) {
          if (!seenIds.has(point.id)) {
            seenIds.add(point.id);
            allResults.push({ ...point, score: 0.32 });
          }
        }
      } catch (err) {
        logger.error({ err, keywords }, 'Keyword fallback search failed');
      }
    }
  }

  if (allResults.length === 0) {
    return { context: '', memories: [], tokenCount: 0 };
  }

  // Fetch DB records
  const qdrantIds = allResults.map((r) => String(r.id));
  const dbMemories = await db.memory.findMany({
    where: {
      qdrantId: { in: qdrantIds },
      userId,
      supersededById: null,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
  });

  const dbMap = new Map(dbMemories.map((m) => [m.qdrantId, m]));

  // Score and filter — use Qdrant similarity score directly
  const scored = allResults
    .map((result) => {
      const dbMem = dbMap.get(String(result.id));
      if (!dbMem) return null;
      if (result.score < MIN_SCORE) return null;
      return { ...dbMem, relevanceScore: result.score, compositeScore: result.score };
    })
    .filter(Boolean);

  // Deduplicate by topicKey (keep highest score)
  const topicKeyMap = new Map();
  for (const m of scored) {
    if (!m.topicKey) continue;
    const existing = topicKeyMap.get(m.topicKey);
    if (!existing || m.compositeScore > existing.compositeScore) {
      topicKeyMap.set(m.topicKey, m);
    }
  }
  const deduped = scored.filter((m) => !m.topicKey || topicKeyMap.get(m.topicKey)?.id === m.id);

  // Token-proportional selection
  const sorted = deduped.sort((a, b) => b.compositeScore - a.compositeScore);
  const final = [];
  let tokenBudget = MAX_TOKENS;

  for (const m of sorted) {
    if (final.length >= MAX_MEMORIES) break;
    const tokens = estimateTokens(m.content);
    if (tokens <= tokenBudget) {
      final.push(m);
      tokenBudget -= tokens;
    }
  }

  logger.info(
    { userId, topic: topicString, totalFromQdrant: allResults.length, finalInjected: final.length },
    'lookup:summary'
  );

  if (final.length === 0) {
    const empty = { context: '', memories: [], tokenCount: 0 };
    try { await redis.setex(cacheKey, LOOKUP_CACHE_TTL, JSON.stringify(empty)); } catch { /* non-fatal */ }
    return empty;
  }

  // Format
  const CATEGORY_LABELS = {
    personal_info: 'Personal',
    preference: 'Preferences',
    technical_decision: 'Technical preferences',
    project: 'Current projects',
    decision: 'Decisions & patterns',
    goal: 'Goals',
    professional: 'Professional',
    temporary: 'Recent activity (use this context)',
    intent: 'Current plans (use this context)',
    general: 'General',
  };

  const groups = {};
  for (const m of final) {
    const cat = m.category || 'general';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(m.content);
  }

  const lines = ['[CONVOMEM CONTEXT]'];
  for (const [cat, items] of Object.entries(groups)) {
    const label = CATEGORY_LABELS[cat] || cat;
    lines.push(`${label}:`);
    for (const item of items) {
      lines.push(`  - ${item}`);
    }
  }
  lines.push('[END CONTEXT]');

  const context = lines.join('\n');
  const tokenCount = MAX_TOKENS - tokenBudget;

  const scores = {};
  for (const m of final) {
    scores[m.id] = parseFloat(m.relevanceScore.toFixed(4));
  }

  const result = { context, memories: final, tokenCount, scores };
  try { await redis.setex(cacheKey, LOOKUP_CACHE_TTL, JSON.stringify(result)); } catch { /* non-fatal */ }
  return result;
}

module.exports = { lookup };
