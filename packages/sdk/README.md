# convomem-sdk

Official JavaScript SDK for the ConvoMem memory API. Zero production dependencies.

## Install

```bash
npm install convomem-sdk
```

## Quick Start

```js
const ConvoMem = require('convomem-sdk');

const client = new ConvoMem({
  apiKey: 'sk-cm-your-key-here',
  // baseUrl: 'http://localhost:8000',  // optional, defaults to localhost
  // timeout: 30000,                     // optional, ms
});

// Save memories from a conversation
const { jobId } = await client.capture([
  { role: 'user', content: 'My name is Alice and I live in London.' },
  { role: 'assistant', content: 'Nice to meet you, Alice!' },
]);

// Get relevant context for a topic
const { context, memories } = await client.lookup('where does Alice live');

// Search all stored memories
const { results, count } = await client.search('London');

// List memories (paginated)
const { memories: list, total, page, pages } = await client.listMemories({ page: 1, limit: 20 });

// Get or delete a single memory
const memory = await client.getMemory('memory-uuid');
await client.deleteMemory('memory-uuid');

// Submit relevance feedback
await client.lookupFeedback({
  memoryIds: ['mem-1', 'mem-2'],
  wasHelpful: true,
  topic: 'London',
});
```

## Error Handling

All API errors throw `ConvoMemError` with `status`, `code`, and `message`:

```js
const { ConvoMemError } = require('convomem-sdk/src/errors');

try {
  await client.lookup('test');
} catch (err) {
  if (err instanceof ConvoMemError) {
    console.log(err.status);  // 401, 429, 500, etc.
    console.log(err.code);    // 'AUTH_REQUIRED', 'RATE_LIMITED', etc.
    console.log(err.message); // human-readable description
  }
}
```

| Status | Code | Meaning |
|--------|------|---------|
| 401 | `AUTH_REQUIRED` | Invalid or missing API key |
| 429 | `RATE_LIMITED` | Too many requests |
| 404 | — | Memory not found |
| 0 | `NETWORK_ERROR` | Server unreachable |
| 0 | `TIMEOUT` | Request exceeded timeout |

## API Methods

| Method | Description |
|--------|-------------|
| `capture(messages, opts?)` | Queue conversation for memory extraction |
| `lookup(topic)` | Get relevant context for a topic |
| `search(query, opts?)` | Semantic search across memories |
| `listMemories(opts?)` | Paginated list of all memories |
| `getMemory(id)` | Fetch a single memory by UUID |
| `deleteMemory(id)` | Permanently delete a memory |
| `lookupFeedback(data)` | Submit relevance feedback |

## License

MIT
