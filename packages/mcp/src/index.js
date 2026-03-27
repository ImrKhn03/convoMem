#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const CONVOMEM_API_KEY = process.env.CONVOMEM_API_KEY;
const CONVOMEM_BASE_URL = process.env.CONVOMEM_BASE_URL || 'http://localhost:8000';

if (!CONVOMEM_API_KEY) {
  process.stderr.write('Error: CONVOMEM_API_KEY environment variable is required\n');
  process.exit(1);
}

/** Make authenticated requests to the ConvoMem API */
async function apiRequest(method, path, { body, params } = {}) {
  let url = `${CONVOMEM_BASE_URL}${path}`;
  if (params) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
    );
    if (qs.toString()) url += `?${qs}`;
  }

  const resp = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': CONVOMEM_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  const text = await resp.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    throw new Error(`Invalid JSON from API (status ${resp.status})`);
  }

  if (!resp.ok && resp.status !== 202) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
}

const SYSTEM_PROMPT =
  'ConvoMem memory lifecycle — follow these 3 steps every conversation:\n' +
  '1. LOOKUP: Call convomem_lookup with the user\'s first message as the topic.\n' +
  '2. RESPOND: Answer the user. Use any returned memories naturally — never quote them or mention the lookup.\n' +
  '3. CAPTURE: After your final response, ALWAYS call convomem_capture with the full conversation. ' +
  'The server decides what to keep — do not pre-filter.\n' +
  'If lookup returned memory IDs, also call convomem_feedback with those IDs and whether they helped your response.';

/**
 * Extract keyword variants from a topic to broaden semantic search.
 * Returns the original topic plus 1-2 keyword phrases, pipe-separated.
 * Pure heuristics — zero latency, no LLM call.
 * @param {string} topic
 * @returns {string}
 */
function expandTopic(topic) {
  const parts = [topic];

  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
    'under', 'again', 'then', 'once', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so',
    'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if',
    'while', 'about', 'up', 'its', 'it', 'i', 'me', 'my', 'mine', 'we',
    'our', 'you', 'your', 'he', 'she', 'they', 'them', 'this', 'that',
    'these', 'those', 'what', 'which', 'who', 'whom', 'recommend',
    'suggest', 'tell', 'give', 'show', 'help', 'find', 'things', 'stuff',
    'something', 'anything', 'please', 'want', 'need', 'like', 'know',
    'think', 'make', 'get', 'let',
  ]);

  // Extract keywords (non-stop, 3+ chars)
  const words = topic.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
  const keywords = words.filter(w => w.length > 2 && !stopWords.has(w));
  if (keywords.length > 0 && keywords.length < words.length) {
    parts.push(keywords.slice(0, 4).join(' '));
  }

  // Detect possessive/indirect references — rephrase to first-person for better embedding match
  const rephrases = [
    { pattern: /\b(near|around)\s+(my|me|here)\b/i, rephrase: 'my location my city' },
    { pattern: /\bmy\s+(area|place|region|neighborhood)\b/i, rephrase: 'my location my city' },
  ];

  for (const { pattern, rephrase } of rephrases) {
    if (pattern.test(topic)) {
      parts.push(rephrase);
      break;
    }
  }

  return [...new Set(parts)].slice(0, 3).join('|');
}

const server = new McpServer({
  name: 'convoMem',
  version: '0.1.0',
});

// ─── Prompt ────────────────────────────────────────────────────────────────

server.registerPrompt(
  'convomem_system',
  {
    title: 'ConvoMem Memory System',
    description: 'ConvoMem memory system prompt — auto-lookup and capture on every conversation',
    argsSchema: {},
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: SYSTEM_PROMPT },
      },
    ],
  })
);

// ─── Pre-filter ────────────────────────────────────────────────────────────

const MEMORY_INDICATORS = [
  /\bi (prefer|like|love|hate|always|never|use|work|am|was|have|need|want)\b/i,
  /\bmy (name|job|role|company|team|stack|preference|favorite|background)\b/i,
  /\bremember\b/i,
  /\bdon'?t (forget|ever)\b/i,
  /\bkeep in mind\b/i,
  /\bi'?m (a |an |the |working|building|using|based)\b/i,
  /\bi (always|never|usually|typically|generally)\b/i,
];

/**
 * Returns true if the conversation contains content worth sending to the capture API.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {boolean}
 */
function hasMemorableContent(messages) {
  return messages
    .filter(m => m.role === 'user')
    .some(m => MEMORY_INDICATORS.some(p => p.test(m.content)));
}

// ─── Tool 1: capture ───────────────────────────────────────────────────────

server.registerTool(
  'convomem_capture',
  {
    title: 'Capture Memories',
    description:
      'Save a conversation to ConvoMem memory. ALWAYS call this once at the end of every conversation. The server extracts and filters facts — send the full conversation without pre-filtering.',
    inputSchema: {
      messages: z
        .preprocess(
          val => typeof val === 'string' ? JSON.parse(val) : val,
          z.array(
            z.object({
              role: z.enum(['user', 'assistant']),
              content: z.string(),
            })
          ).min(1)
        )
        .describe('The conversation messages to extract memories from'),
      platform: z
        .string()
        .optional()
        .describe('Platform hint: mcp, chatgpt, claude, cursor, vscode'),
    },
  },
  async ({ messages, platform }) => {
    if (!hasMemorableContent(messages)) {
      return { content: [{ type: 'text', text: 'Memory capture skipped (no memorable content detected).' }] };
    }
    try {
      const result = await apiRequest('POST', '/api/memories/capture', {
        body: { messages, platform: platform || 'mcp' },
      });
      return {
        content: [
          {
            type: 'text',
            text: `Memory captured (id ${result.captureId})`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Capture failed: ${err.message}` }],
      };
    }
  }
);

// ─── Tool 2: lookup ────────────────────────────────────────────────────────

server.registerTool(
  'convomem_lookup',
  {
    title: 'Lookup Memories',
    description:
      'Retrieve relevant memories for a topic. ALWAYS call this at the start of every conversation with the user\'s first message as the topic. Even if no memories are returned, continue the lifecycle: respond, then call convomem_capture.',
    inputSchema: {
      topic: z.string().describe('The topic or question to look up memories for'),
    },
  },
  async ({ topic }) => {
    try {
      const expandedTopic = expandTopic(topic);
      const result = await apiRequest('GET', '/api/memories/lookup', { params: { topic: expandedTopic } });
      if (!result.context) {
        return {
          content: [{ type: 'text', text: 'No memories found. This is normal for new topics. After responding, call convomem_capture with the full conversation to build memory.' }],
        };
      }
      const memoryIds = (result.memories || []).map(m => m.id).filter(Boolean);
      const scores = result.scores || {};
      const idSuffix = memoryIds.length > 0
        ? `\n\n[Memory IDs for convomem_feedback: ${memoryIds.join(', ')}]\n[Scores: ${JSON.stringify(scores)}]`
        : '';
      return {
        content: [{ type: 'text', text: `${result.context}${idSuffix}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Lookup failed: ${err.message}` }],
      };
    }
  }
);

// ─── Tool 3: feedback ──────────────────────────────────────────────────────

server.registerTool(
  'convomem_feedback',
  {
    title: 'Memory Feedback',
    description:
      'Report whether injected memories were helpful. Call this after convomem_lookup when you can assess if the context improved your response. Trains importance scores so future injections get better over time.',
    inputSchema: {
      memoryIds: z
        .preprocess(
          val => typeof val === 'string' ? JSON.parse(val) : val,
          z.array(z.string()).min(1)
        )
        .describe(
          'Array of memory IDs that were injected — use the ids from the memories array in the lookup response'
        ),
      wasHelpful: z
        .preprocess(
          val => typeof val === 'string' ? val === 'true' : val,
          z.boolean()
        )
        .describe(
          'true if the injected memories were relevant and improved the response; false if they were off-topic or unhelpful'
        ),
      topic: z.string().optional().describe('The original topic that was looked up'),
      scores: z
        .preprocess(
          val => typeof val === 'string' ? JSON.parse(val) : val,
          z.record(z.string(), z.number()).optional()
        )
        .describe(
          'Optional map of memoryId → relevanceScore from the lookup response. Enables weighted feedback — strong matches get larger importance adjustments.'
        ),
    },
  },
  async ({ memoryIds, wasHelpful, topic, scores }) => {
    try {
      const body = { memoryIds, wasHelpful, topic: topic || '' };
      if (scores && Object.keys(scores).length > 0) body.scores = scores;
      const result = await apiRequest('POST', '/api/memories/lookup-feedback', {
        body,
      });
      const direction = wasHelpful ? 'boosted ↑' : 'decayed ↓';
      return {
        content: [
          {
            type: 'text',
            text: `Feedback recorded. Importance ${direction} for ${result.count} memories. Future lookups will reflect this signal.`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Feedback failed: ${err.message}` }],
      };
    }
  }
);

// ─── Tool 4: search ────────────────────────────────────────────────────────

server.registerTool(
  'convomem_search',
  {
    title: 'Search Memories',
    description:
      'Search stored memories semantically. Use this to find specific facts the user has shared in the past.',
    inputSchema: {
      query: z.string().describe('Search query'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max results (default 20)'),
    },
  },
  async ({ query, limit }) => {
    try {
      const result = await apiRequest('GET', '/api/memories/search', {
        params: { q: query, limit },
      });
      if (!result.count) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }
      const lines = result.results.map(
        (r, i) =>
          `${i + 1}. [${r.payload?.category || 'general'}] ${r.payload?.content} (score: ${r.score.toFixed(2)})`
      );
      return {
        content: [
          {
            type: 'text',
            text: `Found ${result.count} memories:\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Search failed: ${err.message}` }],
      };
    }
  }
);

// ─── Tool 5: list ──────────────────────────────────────────────────────────

server.registerTool(
  'convomem_list',
  {
    title: 'List Memories',
    description: 'List the most recent stored memories.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Number of memories to return (default 20)'),
      page: z.number().int().min(1).optional().describe('Page number (default 1)'),
    },
  },
  async ({ limit, page }) => {
    try {
      const result = await apiRequest('GET', '/api/memories', { params: { limit, page } });
      if (!result.total) {
        return { content: [{ type: 'text', text: 'No memories stored yet.' }] };
      }
      const lines = result.memories.map((m) => `• [${m.category || 'general'}] ${m.content}`);
      return {
        content: [
          {
            type: 'text',
            text: `${result.total} total memories (page ${result.page}/${result.pages}):\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `List failed: ${err.message}` }],
      };
    }
  }
);

// ─── Tool 6: graph ──────────────────────────────────────────────────────────

server.registerTool(
  'convomem_graph',
  {
    title: 'Entity Explorer',
    description:
      'Query entities extracted from memories. List all entities, search by name, or get a specific entity.',
    inputSchema: {
      action: z
        .enum(['list', 'search', 'get'])
        .describe('Action: list entities, search by name, or get one entity by ID'),
      query: z.string().optional().describe('Search query (required for action=search)'),
      entityId: z.string().optional().describe('Entity UUID (required for action=get)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results for list/search'),
    },
  },
  async ({ action, query, entityId, limit }) => {
    try {
      let result;
      switch (action) {
        case 'list':
          result = await apiRequest('GET', '/api/entities', { params: { limit } });
          break;
        case 'search':
          if (!query) return { isError: true, content: [{ type: 'text', text: 'query is required for search action' }] };
          result = await apiRequest('GET', '/api/entities/search', { params: { q: query, limit } });
          break;
        case 'get':
          if (!entityId) return { isError: true, content: [{ type: 'text', text: 'entityId is required for get action' }] };
          result = await apiRequest('GET', `/api/entities/${entityId}`);
          break;
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Entity query failed: ${err.message}` }],
      };
    }
  }
);

// ─── Start ─────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('ConvoMem MCP server running\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
