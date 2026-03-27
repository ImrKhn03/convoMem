'use strict';

const OpenAI = require('openai');
const { getDb } = require('../config/db');
const { getRedis } = require('../config/redis');
const { saveMemory, searchMemories, getEmbedding } = require('./memory.service');
const { filterFacts } = require('./sensitive.service');
const logger = require('../utils/logger');

// gpt-4o-mini pricing (per token)
const COST_PER_INPUT_TOKEN  = 0.15 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 0.60 / 1_000_000;
const DAILY_BUDGET_USD = parseFloat(process.env.OPENAI_DAILY_BUDGET_USD || '5');

// Keep trackUsage exactly as original (lines 20-34)
async function trackUsage(usage) {
  if (!usage) return;
  try {
    const redis = getRedis();
    const date = new Date().toISOString().slice(0, 10);
    const key = `openai:daily:${date}`;
    const cost = (usage.prompt_tokens * COST_PER_INPUT_TOKEN) +
                 (usage.completion_tokens * COST_PER_OUTPUT_TOKEN);
    await redis.incrbyfloat(key, cost);
    await redis.expire(key, 48 * 3600);
    logger.debug({ date, tokens: usage.prompt_tokens + usage.completion_tokens, cost: cost.toFixed(6) }, 'OpenAI usage tracked');
  } catch { /* non-fatal */ }
}

// Keep isBudgetExceeded exactly as original
async function isBudgetExceeded() {
  try {
    const redis = getRedis();
    const date = new Date().toISOString().slice(0, 10);
    const spent = parseFloat(await redis.get(`openai:daily:${date}`) || '0');
    return spent >= DAILY_BUDGET_USD;
  } catch {
    return false;
  }
}

let openaiClient;
function getOpenAI() {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

const CATEGORY_TO_MEMORY_TYPE = {
  personal_info:      'fact',
  preference:         'preference',
  goal:               'goal',
  relationship:       'fact',
  professional:       'fact',
  technical_decision: 'decision',
  project:            'fact',
  learning:           'fact',
  experience:         'fact',
  opinion:            'fact',
  context:            'context',
  temporary:          'temporary',
  memory:             'preference',
};

const INTENT_PATTERNS = [
  /\bplans?\s+to\b/i,
  /\bgoing\s+to\b/i,
  /\bwants?\s+to\b/i,
  /\bintends?\s+to\b/i,
  /\bwill\s+(try|order|get|buy|visit|do|make|check)\b/i,
  /\bis\s+about\s+to\b/i,
  /\bthinking\s+of\b/i,
  /\bconsidering\b/i,
];

const TYPE_TTL_MS = {
  intent:    1  * 24 * 60 * 60 * 1000,
  temporary: 6  * 60 * 60 * 1000,
  context:   7  * 24 * 60 * 60 * 1000,
  goal:      null,
  fact:      null,
  preference: null,
  decision:  null,
  technical: null,
};

const VALID_MEMORY_TYPES = new Set(['fact','preference','intent','goal','temporary','decision','context','technical']);

const CATEGORY_SCORES = {
  personal_info: 0.95,
  preference: 0.90,
  goal: 0.85,
  relationship: 0.80,
  professional: 0.75,
  technical_decision: 0.70,
  project: 0.60,
  learning: 0.55,
  experience: 0.50,
  opinion: 0.45,
  context: 0.25,
  temporary: 0.10,
  memory: 0.85,
  default: 0.45,
};

const MIN_DURABILITY = 0.35;

const EXPLICIT_COMMAND_PATTERNS = [
  /\bremember\s+that\b/i,
  /\balways\b/i,
  /\bnever\s+(suggest|use|do|say)\b/i,
  /\bdon'?t\s+ever\b/i,
  /\bplease\s+remember\b/i,
  /\bkeep\s+in\s+mind\b/i,
];

function safeParse(text) {
  const cleaned = text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();
  return JSON.parse(cleaned);
}

// Keep callLLM exactly as original
async function callLLM(messages, { timeout = 30000, maxRetries = 3, model = 'gpt-4o-mini' } = {}) {
  if (await isBudgetExceeded()) {
    logger.warn({ budget: DAILY_BUDGET_USD }, 'Daily OpenAI budget exceeded — skipping LLM call');
    return null;
  }

  const openai = getOpenAI();
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await openai.chat.completions.create(
        {
          model,
          messages,
          temperature: 0.1,
          max_tokens: 2000,
        },
        { signal: controller.signal }
      );

      clearTimeout(timer);
      await trackUsage(resp.usage);
      return resp.choices[0].message.content;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
      }
    }
  }

  logger.error({ err: lastError }, 'LLM call failed after retries');
  return null;
}

// Keep getExtractionPrompt exactly as original
function getExtractionPrompt(platform, conversationText, hasExplicitCommands = false) {
  const platformInstructions = {
    cursor: 'Platform: code editor. Prioritize: tech stack choices, architectural decisions, coding preferences, tooling preferences.',
    vscode: 'Platform: code editor. Prioritize: tech stack choices, architectural decisions, coding preferences, tooling preferences.',
    chatgpt: 'Platform: chat. Balance personal preferences, goals, decisions, and technical knowledge.',
    claude: 'Platform: chat. Balance personal preferences, goals, decisions, and technical knowledge.',
    mcp: 'Platform: AI agent. Balance personal preferences, goals, decisions, and technical knowledge.',
    voice: 'Platform: voice/customer service. Prioritize: user preferences, stated needs, history, and complaints.',
  };

  const instruction = platformInstructions[platform] || 'Balance personal preferences, goals, decisions, and technical knowledge.';

  return `You are a memory extraction system that identifies facts ABOUT THE USER for long-term personal memory.

${instruction}

## Core principle
Only extract facts about the USER — their identity, preferences, decisions, goals, knowledge, and instructions.
NEVER extract what the assistant did, said, or implemented. The assistant is a tool, not a person to remember.

## Rules
1. Extract only facts the USER explicitly stated (not inferred, not from assistant messages)
2. Each fact must be a single, self-contained statement that would be useful in a FUTURE conversation
3. Consolidate related facts of the SAME category into one statement — prefer 1 rich fact over 3 granular ones.
   NEVER merge facts from different categories.
4. Phrase facts as "[User] ..." statements (e.g. "User prefers dark mode" not "Dark mode was mentioned")
5. Ask: "Would knowing this help an AI assist this user better next time?" — if no, skip it

## Categories (pick the most specific one)
personal_info, preference, goal, relationship, professional, technical_decision, project, learning, opinion

Use "context" or "temporary" ONLY for explicitly time-bound statements ("I'm tired today", "working on X this week").

## Memory Types (pick one)
- fact: stable factual info (identity, knowledge, where they work, past experiences)
- preference: what the user likes, prefers, or dislikes
- intent: upcoming events or short-term plans with a future date or timeframe — expires in ~24h
- goal: longer-term aspirations ("learning Rust", "building a startup", "wants to lose weight")
- temporary: transient present-moment states only ("tired today", "currently debugging X")
- decision: a concrete decision the user has made (tech stack, process, architecture)
- technical: technical fact or technical preference

## Output format
Return a JSON array. If nothing is worth remembering, return [].
[
  { "content": "User ...", "category": "category", "memoryType": "type", "topicKey": "current_employer", "confidence": 0.9, "sourceContext": "brief context", "searchTags": ["employer", "job", "company", "work", "career"] }
]
- topicKey: a key for deduplication (e.g. "current_employer", "preferred_backend_language")
- confidence: 0.0-1.0 — how certain you are the user stated this
- sourceContext: 1-2 sentence summary of conversation context
- searchTags: array of 5-10 lowercase keywords for retrieval
${hasExplicitCommands ? '\nIMPORTANT: Messages marked [EXPLICIT] are direct user instructions ("remember that", "always", "never"). These are the HIGHEST priority to extract. Set confidence: 1.0 for these.' : ''}

Conversation:
${conversationText}`;
}

function findExplicitCommandIndices(messages) {
  const indices = new Set();
  messages.forEach((msg, i) => {
    if (msg.role === 'user' && EXPLICIT_COMMAND_PATTERNS.some((p) => p.test(msg.content))) {
      indices.add(i);
    }
  });
  return indices;
}

/**
 * Stub: always returns no contradiction.
 * The full version uses LLM-based contradiction detection.
 */
async function detectContradiction(existingContent, newContent) {
  return { contradicts: false, newer_is_better: false };
}

/**
 * Simplified capture pipeline (open-source version).
 *
 * Differences from the full version:
 * - No second LLM validation pass
 * - Dedup by exact topicKey match only (no semantic similarity)
 * - No LLM-based contradiction detection
 * - Simplified durability scoring
 */
async function runCapturePipeline(userId, messages, opts = {}) {
  const platform = opts.platform || 'default';
  const captureId = opts.captureId || null;
  const db = getDb();

  const results = { saved: 0, skipped: 0, superseded: 0, explicit: 0, errors: [] };

  try {
    // Stage 0: Tag messages with explicit commands
    const explicitIndices = findExplicitCommandIndices(messages);
    results.explicit = explicitIndices.size;

    // Stage 1: LLM extraction (single pass)
    const conversationText = messages
      .map((m, i) => `${explicitIndices.has(i) ? '[EXPLICIT] ' : ''}${m.role}: ${m.content}`)
      .join('\n');
    const extractionPrompt = getExtractionPrompt(platform, conversationText, explicitIndices.size > 0);

    const extractionResult = await callLLM([{ role: 'user', content: extractionPrompt }]);
    if (!extractionResult) {
      logger.warn({ userId }, 'Extraction returned null');
      return results;
    }

    let facts;
    try {
      facts = safeParse(extractionResult);
      if (!Array.isArray(facts)) facts = [];
    } catch (err) {
      logger.error({ err, userId, raw: extractionResult }, 'Failed to parse extraction result');
      return results;
    }

    logger.debug({ userId, count: facts.length }, 'capture:stage1 extraction complete');

    if (facts.length === 0) return results;

    // Derive sourceContext fallback
    const userMessages = messages.filter((m) => m.role === 'user').map((m) => m.content);
    const fallbackContext = userMessages[0]
      ? userMessages[0].slice(0, 150).replace(/\s+/g, ' ').trim()
      : null;
    for (const fact of facts) {
      if (!fact.sourceContext && fallbackContext) {
        fact.sourceContext = fallbackContext;
      }
    }

    // Stage 2: Durability scoring + filtering
    const scoredFacts = facts
      .map((fact) => {
        const isExplicit = fact.confidence === 1.0;
        if (isExplicit) {
          return { ...fact, durability: 1.0, memoryType: 'preference', expiresAt: null };
        }

        let memoryType = fact.memoryType;
        if (!memoryType || !VALID_MEMORY_TYPES.has(memoryType)) {
          memoryType = CATEGORY_TO_MEMORY_TYPE[fact.category] || 'fact';
        }
        if (memoryType !== 'intent' && INTENT_PATTERNS.some((p) => p.test(fact.content))) {
          memoryType = 'intent';
        }

        const baseScore = CATEGORY_SCORES[fact.category] || CATEGORY_SCORES.default;
        const durability = baseScore * (fact.confidence || 0.8);

        let expiresAt = null;
        const typeTtl = TYPE_TTL_MS[memoryType];
        if (typeTtl !== null && typeTtl !== undefined) {
          expiresAt = new Date(Date.now() + typeTtl);
        }

        return { ...fact, durability, memoryType, expiresAt };
      })
      .filter((f) => f.durability >= MIN_DURABILITY);

    // Stage 2b: Sensitive filter
    const { safe: safeFacts } = filterFacts(scoredFacts, opts.filters || { pii: true });

    // Stage 3: Dedup by exact topicKey match only
    for (const fact of safeFacts) {
      try {
        if (fact.topicKey) {
          const existing = await db.memory.findFirst({
            where: { userId, topicKey: fact.topicKey, supersededById: null },
          });

          if (existing) {
            // Simple: update existing memory with new content
            await db.memory.update({
              where: { id: existing.id },
              data: { supersededById: existing.id },
            });
            const newMemory = await saveMemory(userId, { ...fact, captureId, platform: opts.platform || null });
            await db.memory.update({
              where: { id: existing.id },
              data: { supersededById: newMemory.id },
            });
            results.saved++;
            results.superseded++;
            continue;
          }
        }

        // Stage 4: Save new memory
        await saveMemory(userId, { ...fact, captureId, platform: opts.platform || null });
        results.saved++;
      } catch (err) {
        logger.error({ err, userId, fact: fact.content }, 'Error processing fact');
        results.errors.push(err.message);
      }
    }
  } catch (err) {
    logger.error({ err, userId }, 'Capture pipeline failed');
    results.errors.push(err.message);
  }

  // Stage 5: Entity extraction (non-blocking, fire-and-forget)
  if (results.saved > 0) {
    const entityService = require('./entity.service');
    db.memory.findMany({
      where: { userId, captureId },
      select: { id: true, content: true, category: true },
    }).then((savedMemories) => {
      if (savedMemories.length > 0) {
        entityService.extractAndSave(userId, savedMemories);
      }
    }).catch((err) => {
      logger.error({ err, userId }, 'Failed to trigger entity extraction');
    });
  }

  return results;
}

module.exports = {
  runCapturePipeline,
  detectContradiction,
  callLLM,
  safeParse,
  getExtractionPrompt,
  CATEGORY_SCORES,
  CATEGORY_TO_MEMORY_TYPE,
  INTENT_PATTERNS,
  TYPE_TTL_MS,
  EXPLICIT_COMMAND_PATTERNS,
  findExplicitCommandIndices,
  DAILY_BUDGET_USD,
  isBudgetExceeded,
};
