'use strict';

/**
 * Capture pipeline unit tests.
 * Tests durability scoring, explicit command detection, deduplication logic,
 * and the safeParse helper — all without hitting OpenAI or the DB.
 */

const {
  safeParse,
  CATEGORY_SCORES,
  EXPLICIT_COMMAND_PATTERNS,
  findExplicitCommandIndices,
  getExtractionPrompt,
  detectContradiction,
  runCapturePipeline,
} = require('../src/services/capture.service');

// ─── Mock external deps ────────────────────────────────────────────────────

jest.mock('../src/config/redis', () => ({
  getRedis: () => ({
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(60),
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
  }),
}));

jest.mock('../src/jobs/queues', () => ({
  captureQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job' }) },
  webhookQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-wh-job' }) },
  connection: {},
}));

jest.mock('../src/config/qdrant', () => ({
  getQdrant: () => ({
    search: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue({ status: 'ok' }),
    delete: jest.fn().mockResolvedValue({ status: 'ok' }),
    getCollections: jest.fn().mockResolvedValue({ collections: [{ name: 'personal_memories' }] }),
    createCollection: jest.fn(),
    createPayloadIndex: jest.fn(),
  }),
  setupCollections: jest.fn().mockResolvedValue(undefined),
  PERSONAL_COLLECTION: 'personal_memories',
}));

let mockChatResponse = '[]';

jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    embeddings: {
      create: jest.fn().mockResolvedValue({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
    },
    chat: {
      completions: {
        create: jest.fn().mockImplementation(() =>
          Promise.resolve({ choices: [{ message: { content: mockChatResponse } }] })
        ),
      },
    },
  }))
);

jest.mock('../src/config/db', () => {
  const db = {
    memory: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'mem-1', ...args.data })),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ memoryCount: 0 }),
    },
  };
  return { getDb: () => db };
});

jest.mock('../src/services/webhook.service', () => ({
  dispatchEvent: jest.fn().mockResolvedValue(undefined),
}));

// ─── safeParse ─────────────────────────────────────────────────────────────

describe('safeParse', () => {
  it('parses plain JSON', () => {
    expect(safeParse('[{"content":"test"}]')).toEqual([{ content: 'test' }]);
  });

  it('strips ```json fences', () => {
    const input = '```json\n[{"content":"fact"}]\n```';
    expect(safeParse(input)).toEqual([{ content: 'fact' }]);
  });

  it('strips plain ``` fences', () => {
    const input = '```\n[{"content":"fact"}]\n```';
    expect(safeParse(input)).toEqual([{ content: 'fact' }]);
  });

  it('throws on invalid JSON', () => {
    expect(() => safeParse('not json')).toThrow();
  });
});

// ─── Explicit command detection ────────────────────────────────────────────

describe('findExplicitCommandIndices', () => {
  it('detects "remember that"', () => {
    const msgs = [
      { role: 'user', content: 'Please remember that I use tabs not spaces' },
      { role: 'assistant', content: 'Got it.' },
    ];
    expect(findExplicitCommandIndices(msgs)).toEqual(new Set([0]));
  });

  it('detects "always"', () => {
    const msgs = [{ role: 'user', content: 'I always prefer dark mode' }];
    expect(findExplicitCommandIndices(msgs)).toEqual(new Set([0]));
  });

  it('detects "never suggest"', () => {
    const msgs = [{ role: 'user', content: 'Never suggest using JavaScript' }];
    expect(findExplicitCommandIndices(msgs)).toEqual(new Set([0]));
  });

  it('ignores assistant messages', () => {
    const msgs = [{ role: 'assistant', content: 'I will always remember that.' }];
    expect(findExplicitCommandIndices(msgs)).toEqual(new Set());
  });

  it('returns empty set for normal messages', () => {
    const msgs = [
      { role: 'user', content: 'I like Python' },
      { role: 'assistant', content: 'Python is great.' },
    ];
    expect(findExplicitCommandIndices(msgs)).toEqual(new Set());
  });

  it('detects multiple explicit messages', () => {
    const msgs = [
      { role: 'user', content: 'Remember that I use vim' },
      { role: 'assistant', content: 'Noted.' },
      { role: 'user', content: 'Also always use tabs' },
    ];
    expect(findExplicitCommandIndices(msgs)).toEqual(new Set([0, 2]));
  });
});

// ─── CATEGORY_SCORES ───────────────────────────────────────────────────────

describe('CATEGORY_SCORES durability values', () => {
  it('personal_info has highest durability (0.95)', () => {
    expect(CATEGORY_SCORES.personal_info).toBe(0.95);
  });

  it('temporary has lowest durability (0.10)', () => {
    expect(CATEGORY_SCORES.temporary).toBe(0.10);
  });

  it('preference is above the MIN_DURABILITY threshold (0.35)', () => {
    expect(CATEGORY_SCORES.preference * 0.8).toBeGreaterThan(0.35);
  });

  it('context with typical confidence falls below MIN_DURABILITY', () => {
    // context = 0.25, at confidence 0.8 → 0.20 < 0.35
    expect(CATEGORY_SCORES.context * 0.8).toBeLessThan(0.35);
  });

  it('experience with typical confidence passes MIN_DURABILITY', () => {
    // experience = 0.50, at confidence 0.8 → 0.40 > 0.35
    expect(CATEGORY_SCORES.experience * 0.8).toBeGreaterThan(0.35);
  });

  it('temporary * full confidence still falls below MIN_DURABILITY', () => {
    expect(CATEGORY_SCORES.temporary * 1.0).toBeLessThan(0.35);
  });
});

// ─── detectContradiction ───────────────────────────────────────────────────

describe('detectContradiction', () => {
  it('returns no contradiction when LLM says so', async () => {
    mockChatResponse = '{"contradicts": false, "newer_is_better": false}';
    const result = await detectContradiction('I use Python', 'I use Python for scripting');
    expect(result.contradicts).toBe(false);
  });

  it('returns contradiction when LLM detects one', async () => {
    mockChatResponse = '{"contradicts": true, "newer_is_better": true}';
    const result = await detectContradiction('I prefer spaces', 'I prefer tabs');
    expect(result.contradicts).toBe(true);
    expect(result.newer_is_better).toBe(true);
  });

  it('returns safe default when LLM returns null/garbage', async () => {
    mockChatResponse = 'definitely not json';
    const result = await detectContradiction('fact a', 'fact b');
    expect(result).toEqual({ contradicts: false, newer_is_better: false });
  });
});

// ─── runCapturePipeline ────────────────────────────────────────────────────

describe('runCapturePipeline', () => {
  const userId = 'test-user-pipeline';

  beforeEach(() => {
    mockChatResponse = '[]';
    jest.clearAllMocks();
    const { getDb } = require('../src/config/db');
    const db = getDb();
    db.memory.findFirst.mockResolvedValue(null);
    db.memory.findMany.mockResolvedValue([]);
  });

  it('returns zero results when LLM extracts nothing', async () => {
    mockChatResponse = '[]';
    const result = await runCapturePipeline(userId, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
    expect(result.saved).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('saves a valid extracted fact', async () => {
    mockChatResponse = JSON.stringify([
      { content: 'User prefers Python', category: 'preference', topicKey: 'language_pref', confidence: 0.9 },
    ]);
    const { getDb } = require('../src/config/db');
    const db = getDb();

    const result = await runCapturePipeline(userId, [
      { role: 'user', content: 'I prefer Python for all my projects.' },
      { role: 'assistant', content: 'Noted.' },
    ]);

    expect(result.saved).toBe(1);
    expect(db.memory.create).toHaveBeenCalledTimes(1);
  });

  it('filters out low-durability temporary facts', async () => {
    mockChatResponse = JSON.stringify([
      { content: 'User is tired today', category: 'temporary', topicKey: 'mood_today', confidence: 0.9 },
    ]);
    const result = await runCapturePipeline(userId, [
      { role: 'user', content: 'I am really tired today.' },
      { role: 'assistant', content: 'Rest well!' },
    ]);
    expect(result.saved).toBe(0);
  });

  it('skips duplicate when topicKey already exists', async () => {
    mockChatResponse = JSON.stringify([
      { content: 'User prefers Python', category: 'preference', topicKey: 'language_pref', confidence: 0.9 },
    ]);
    const { getDb } = require('../src/config/db');
    const db = getDb();
    db.memory.findMany.mockResolvedValue([{
      id: 'existing-mem',
      content: 'User prefers Python',
      topicKey: 'language_pref',
      supersededById: null,
    }]);

    const result = await runCapturePipeline(userId, [
      { role: 'user', content: 'I prefer Python.' },
      { role: 'assistant', content: 'Got it.' },
    ]);

    expect(result.skipped).toBe(1);
    expect(result.saved).toBe(0);
  });

  it('returns a result object with errors array even on empty input', async () => {
    mockChatResponse = '[]';
    const result = await runCapturePipeline(userId, [
      { role: 'user', content: 'test message' },
    ]);
    expect(result).toHaveProperty('saved');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.errors)).toBe(true);
  });
});

// ─── getExtractionPrompt quality guards ──────────────────────────────────

describe('getExtractionPrompt', () => {
  const conv = 'user: I prefer tabs\nassistant: Got it.';

  it('instructs LLM to only extract facts about the USER', () => {
    const prompt = getExtractionPrompt('default', conv);
    expect(prompt).toContain('facts ABOUT THE USER');
    expect(prompt).toContain('NEVER extract what the assistant did');
  });

  it('includes consolidation instruction', () => {
    const prompt = getExtractionPrompt('default', conv);
    expect(prompt).toContain('Consolidate related facts');
    expect(prompt).toContain('1 rich fact over 3 granular');
  });

  it('includes future-reusability filter', () => {
    const prompt = getExtractionPrompt('default', conv);
    expect(prompt).toContain('useful in a FUTURE conversation');
  });

  it('includes bad examples to avoid', () => {
    const prompt = getExtractionPrompt('default', conv);
    expect(prompt).toContain('Assistant applied 6 changes');
    expect(prompt).toContain('implementation detail');
  });

  it('marks explicit commands with confidence 1.0 when present', () => {
    const prompt = getExtractionPrompt('default', conv, true);
    expect(prompt).toContain('HIGHEST priority');
    expect(prompt).toContain('confidence: 1.0');
  });

  it('uses platform-specific instructions for cursor', () => {
    const prompt = getExtractionPrompt('cursor', conv);
    expect(prompt).toContain('code editor');
    expect(prompt).toContain('tech stack');
  });

  it('uses platform-specific instructions for mcp', () => {
    const prompt = getExtractionPrompt('mcp', conv);
    expect(prompt).toContain('AI agent');
  });
});
