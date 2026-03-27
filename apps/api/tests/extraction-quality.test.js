'use strict';

/**
 * Extraction quality integration test.
 * Hits the real OpenAI API to verify the extraction + validation prompts
 * produce high-quality, user-centric memories.
 *
 * Run: OPENAI_API_KEY=... npx jest tests/extraction-quality.test.js --verbose
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const OpenAI = require('openai');
const { getExtractionPrompt, safeParse, CATEGORY_SCORES } = require('../src/services/capture.service');

const MIN_DURABILITY = 0.35;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function callLLM(prompt) {
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2000,
  });
  return resp.choices[0].message.content;
}

async function extractFacts(messages, platform = 'mcp') {
  const conversationText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  const extractionPrompt = getExtractionPrompt(platform, conversationText, false);

  const raw = await callLLM(extractionPrompt);
  let facts;
  try {
    facts = safeParse(raw);
    if (!Array.isArray(facts)) facts = [];
  } catch {
    console.error('Failed to parse extraction:', raw);
    return { facts: [], scored: [], raw };
  }

  // Apply durability scoring
  const scored = facts.map(f => {
    const base = CATEGORY_SCORES[f.category] || CATEGORY_SCORES.default;
    const durability = f.confidence === 1.0 ? 1.0 : base * (f.confidence || 0.8);
    return { ...f, durability };
  }).filter(f => f.durability >= MIN_DURABILITY);

  return { facts, scored, raw };
}

// ─── Test Scenarios ───────────────────────────────────────────────────────

describe('Extraction quality (live LLM)', () => {
  jest.setTimeout(60000); // OpenAI calls need time

  // Scenario 1: The EXACT conversation that produced bad memories
  test('Scenario 1: MCP prompt fix conversation — should NOT extract assistant actions', async () => {
    const messages = [
      { role: 'user', content: 'Implement the following plan: Fix ConvoMem MCP Prompt — Make All LLMs/Agents Follow the Memory Lifecycle. Changes to packages/mcp/src/index.js and ~/.claude/CLAUDE.md.' },
      { role: 'assistant', content: 'Now I\'ll apply all 6 changes in parallel. Applied changes: SYSTEM_PROMPT updated to 3-step lifecycle, convomem_capture description changed to ALWAYS, lookup description updated, no-memories response updated, memory ID extraction added, CLAUDE.md updated.' },
      { role: 'user', content: 'remember that always to check project status md file when answering task remaining tasks' },
      { role: 'assistant', content: 'Saved. I\'ll always check docs/PROJECT_STATUS.md before answering questions about remaining tasks or project status.' },
      { role: 'user', content: 'okay now why didn\'t you use the MCP server?' },
      { role: 'assistant', content: 'You\'re right — that\'s ironic. I just implemented a fix to make agents always follow the 3-step memory lifecycle, and then I didn\'t follow it myself. I used the local file-based memory instead of the ConvoMem MCP tools.' },
    ];

    const { scored, facts } = await extractFacts(messages);

    console.log('\n=== SCENARIO 1: MCP prompt fix conversation ===');
    console.log('Extracted:', JSON.stringify(facts, null, 2));
    console.log('After durability filter:', JSON.stringify(scored, null, 2));

    // Should NOT contain assistant actions
    const allContent = scored.map(f => f.content.toLowerCase()).join(' ');
    expect(allContent).not.toMatch(/assistant (applied|implemented|used)/i);
    expect(allContent).not.toMatch(/6 changes/i);
    expect(allContent).not.toMatch(/system_prompt/i);

    // SHOULD contain the explicit user preference about PROJECT_STATUS.md
    const hasProjectStatus = scored.some(f =>
      f.content.toLowerCase().includes('project_status') || f.content.toLowerCase().includes('project status')
    );
    expect(hasProjectStatus).toBe(true);

    // Should be concise — max 2-3 facts, not 8
    expect(scored.length).toBeLessThanOrEqual(3);
  });

  // Scenario 2: Rich personal conversation — should extract identity + preferences
  test('Scenario 2: Personal conversation — should extract user identity and preferences', async () => {
    const messages = [
      { role: 'user', content: 'Hey, I\'m a senior backend engineer at Stripe. I\'ve been writing Go for about 8 years but I\'m picking up Rust for a side project.' },
      { role: 'assistant', content: 'Welcome! That\'s a solid background. Go and Rust share some philosophy around explicitness. What kind of side project are you building?' },
      { role: 'user', content: 'A CLI tool for managing my home lab infrastructure. I run Proxmox with about 12 VMs. Also I prefer dark mode in everything and please always use snake_case in code examples.' },
      { role: 'assistant', content: 'Nice setup! I\'ll use snake_case for all code. For a Rust CLI, you\'ll probably want clap for argument parsing and tokio for async operations.' },
    ];

    const { scored } = await extractFacts(messages, 'claude');

    console.log('\n=== SCENARIO 2: Personal conversation ===');
    console.log('Final memories:', JSON.stringify(scored, null, 2));

    // Should capture key identity facts
    const allContent = scored.map(f => f.content.toLowerCase()).join(' ');
    expect(allContent).toMatch(/stripe|senior.*engineer|backend/i);
    expect(allContent).toMatch(/go|golang/i);
    expect(allContent).toMatch(/rust/i);

    // Should capture preferences
    const hasPreferences = scored.some(f =>
      f.content.toLowerCase().includes('snake_case') || f.content.toLowerCase().includes('dark mode')
    );
    expect(hasPreferences).toBe(true);

    // Should be consolidated — not one fact per sentence, but rich convos can have 4-6
    expect(scored.length).toBeLessThanOrEqual(7);
    expect(scored.length).toBeGreaterThanOrEqual(2);
  });

  // Scenario 3: Trivial conversation — should extract nothing or very little
  test('Scenario 3: Trivial chitchat — should extract almost nothing', async () => {
    const messages = [
      { role: 'user', content: 'Hey what\'s up' },
      { role: 'assistant', content: 'Not much! How can I help you today?' },
      { role: 'user', content: 'Can you explain what a hashmap is?' },
      { role: 'assistant', content: 'A hashmap is a data structure that maps keys to values using a hash function for O(1) average lookup time.' },
      { role: 'user', content: 'Cool thanks' },
      { role: 'assistant', content: 'You\'re welcome!' },
    ];

    const { scored } = await extractFacts(messages, 'chatgpt');

    console.log('\n=== SCENARIO 3: Trivial chitchat ===');
    console.log('Final memories:', JSON.stringify(scored, null, 2));

    // Trivial conversation — should produce 0-1 facts max
    expect(scored.length).toBeLessThanOrEqual(1);
  });

  // Scenario 4: Explicit memory commands — must capture with high confidence
  test('Scenario 4: Explicit memory commands — must capture all with confidence 1.0', async () => {
    const messages = [
      { role: 'user', content: 'Remember that I\'m allergic to peanuts' },
      { role: 'assistant', content: 'Noted — I\'ll keep that in mind.' },
      { role: 'user', content: 'Also please never suggest using MongoDB, I had terrible experiences with it at my last job' },
      { role: 'assistant', content: 'Understood, I\'ll avoid MongoDB recommendations.' },
      { role: 'user', content: 'And always format code with 2-space indentation' },
      { role: 'assistant', content: 'Got it — 2-space indent for all code.' },
    ];

    // These messages have explicit commands, so mark them
    const conversationText = messages
      .map((m, i) => {
        const isExplicit = m.role === 'user' && /\b(remember\s+that|always|never\s+(suggest|use))\b/i.test(m.content);
        return `${isExplicit ? '[EXPLICIT] ' : ''}${m.role}: ${m.content}`;
      })
      .join('\n');
    const extractionPrompt = getExtractionPrompt('claude', conversationText, true);

    const raw = await callLLM(extractionPrompt);
    let facts;
    try {
      facts = safeParse(raw);
    } catch {
      facts = [];
    }

    console.log('\n=== SCENARIO 4: Explicit commands ===');
    console.log('Extracted:', JSON.stringify(facts, null, 2));

    // All 3 explicit instructions should be captured
    expect(facts.length).toBeGreaterThanOrEqual(3);

    // All should have confidence 1.0
    const allHighConf = facts.every(f => f.confidence >= 0.95);
    expect(allHighConf).toBe(true);

    // Should include the key facts
    const allContent = facts.map(f => f.content.toLowerCase()).join(' ');
    expect(allContent).toMatch(/peanut|allerg/i);
    expect(allContent).toMatch(/mongodb/i);
    expect(allContent).toMatch(/2.?space|indent/i);
  });

  // Scenario 5: Technical coding session — should extract decisions not actions
  test('Scenario 5: Coding session — should extract decisions, not implementation steps', async () => {
    const messages = [
      { role: 'user', content: 'Let\'s set up the auth system. I want JWT with refresh tokens, 15 minute access token expiry. Use bcrypt with 12 rounds for passwords.' },
      { role: 'assistant', content: 'I\'ll implement JWT auth with those specs. Creating auth middleware, token utility, and user routes...' },
      { role: 'assistant', content: 'Done. I\'ve created:\n- src/middleware/auth.js — JWT verification\n- src/utils/tokens.js — sign/verify with 15m expiry\n- src/routes/auth.routes.js — login/register/refresh\n- Updated schema.prisma with refreshToken family rotation' },
      { role: 'user', content: 'Perfect. For the database, I decided to go with PostgreSQL over MySQL because we need JSONB support for the metadata fields.' },
      { role: 'assistant', content: 'Good call — PostgreSQL\'s JSONB gives you indexed JSON queries which MySQL can\'t match.' },
    ];

    const { scored } = await extractFacts(messages, 'cursor');

    console.log('\n=== SCENARIO 5: Coding session ===');
    console.log('Final memories:', JSON.stringify(scored, null, 2));

    // Should capture architectural DECISIONS
    const allContent = scored.map(f => f.content.toLowerCase()).join(' ');
    expect(allContent).toMatch(/jwt|refresh.?token/i);
    expect(allContent).toMatch(/postgres/i);

    // Should NOT contain file paths or implementation details
    expect(allContent).not.toMatch(/src\/middleware/i);
    expect(allContent).not.toMatch(/schema\.prisma/i);
    expect(allContent).not.toMatch(/i'?ve created/i);

    expect(scored.length).toBeLessThanOrEqual(4);
  });
});
