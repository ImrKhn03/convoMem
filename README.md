<p align="center">
  <h1 align="center">ConvoMem</h1>
  <p align="center"><strong>Persistent memory for AI assistants — self-hosted, open source.</strong></p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0 License"></a>
  <a href="https://hub.docker.com"><img src="https://img.shields.io/badge/docker-ready-blue.svg" alt="Docker"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-green.svg" alt="Node 20+">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">
</p>

---

Your AI forgets everything the moment a session ends. ConvoMem fixes that.

Send it a conversation — it extracts the facts worth keeping, stores them as vector embeddings, and returns the most relevant ones as ready-to-inject context for your next prompt. Your AI starts knowing who you are, what you're building, and how you like to work.

One `docker compose up` gets you a full memory API with background processing, vector search, auth, an MCP server, a Chrome extension, and an SDK — no assembly required.

## How It Works

```
Conversation ──▶ Capture ──▶ Extract ──▶ Filter ──▶ Store ──▶ Inject
                    │            │           │          │         │
                 background   LLM pulls   importance  Qdrant   relevant
                   queue      out facts    + dedup   + Postgres  context
```

**Capture** — POST a conversation to the API. A background worker uses an LLM to pull out structured facts, filters out low-signal noise, deduplicates against what's already stored, then saves to Postgres and Qdrant.

**Lookup** — GET by topic. ConvoMem finds the most relevant memories via vector similarity and returns formatted context you can prepend directly to your next LLM prompt.

## What's Included

- **Automatic fact extraction** — pulls out preferences, decisions, goals, and personal info from raw conversation text
- **Smart filtering** — short-lived context expires automatically; important facts persist
- **Deduplication** — same fact won't be stored twice
- **Entity extraction** — people, places, organizations, and technologies are identified and linked across memories
- **PII protection** — SSNs, credit card numbers, and API keys are blocked before anything is stored
- **MCP server** — native integration with Claude Desktop and Cursor
- **Chrome extension** — automatically captures context from ChatGPT and Claude.ai
- **Node.js SDK** — zero-dependency client package
- **Webhooks** — real-time events when memories are captured or updated
- **Works with any LLM** — ChatGPT, Claude, Cursor, Copilot, Gemini, or your own stack

## Quick Start

### Docker Compose (recommended)

```bash
# Clone the repo
git clone https://github.com/your-org/convomem.git
cd convomem

# Configure environment
cp apps/api/.env.example apps/api/.env
# Edit .env with your OpenAI API key and secrets

# Start everything
docker compose up -d

# Register a user
curl -X POST http://localhost:8000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password", "name": "Your Name"}'
```

The API will be running at `http://localhost:8000` with Swagger docs at `http://localhost:8000/api/docs`.

### Environment Variables

```bash
# Required
DATABASE_URL=postgresql://convomem:password@localhost:5432/convomem
OPENAI_API_KEY=sk-...
JWT_SECRET=your-random-secret-min-32-chars
REFRESH_SECRET=another-random-secret-min-32-chars

# Optional
QDRANT_URL=http://localhost:6333        # Default: http://localhost:6333
REDIS_URL=redis://localhost:6379        # Default: redis://localhost:6379
PORT=8000                               # Default: 8000
CORS_ORIGINS=http://localhost:3000      # Comma-separated allowed origins
```

## Integrations

### MCP Server (Claude Desktop / Cursor)

The MCP server lets Claude or Cursor automatically look up and capture memories.

```bash
cd packages/mcp
npm install
```

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "convomem": {
      "command": "node",
      "args": ["/path/to/convomem/packages/mcp/index.js"],
      "env": {
        "CONVOMEM_API_KEY": "sk-cm-your-api-key",
        "CONVOMEM_BASE_URL": "http://localhost:8000"
      }
    }
  }
}
```

Available MCP tools:
- `convomem_lookup` — Find relevant memories for a topic
- `convomem_capture` — Save facts from a conversation
- `convomem_feedback` — Mark memories as helpful/unhelpful

### SDK (npm package)

```bash
npm install convomem-sdk
```

```javascript
const { ConvoMemClient } = require('convomem-sdk');

const client = new ConvoMemClient({
  apiKey: 'sk-cm-your-api-key',
  baseUrl: 'http://localhost:8000',
});

// Capture memories from a conversation
const result = await client.capture({
  messages: [
    { role: 'user', content: 'I prefer dark mode and use VS Code' },
    { role: 'assistant', content: 'Noted! I\'ll remember your preferences.' },
  ],
});

// Look up relevant memories
const context = await client.lookup({ topic: 'editor preferences' });
console.log(context);
// => "User prefers dark mode. User's primary editor is VS Code."

// Search memories
const memories = await client.search({ query: 'dark mode' });
```

### Chrome Extension

The Chrome extension automatically captures conversations from ChatGPT and Claude web interfaces.

1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension/` directory
4. Click the ConvoMem icon and enter your API key

### REST API

```bash
# Capture memories
curl -X POST http://localhost:8000/api/memories/capture \
  -H "X-API-Key: sk-cm-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "I live in San Francisco and work at Acme Corp"},
      {"role": "assistant", "content": "Got it!"}
    ]
  }'

# Lookup memories by topic
curl "http://localhost:8000/api/memories/lookup?topic=where+does+user+live" \
  -H "X-API-Key: sk-cm-your-key"

# List all memories
curl http://localhost:8000/api/memories \
  -H "X-API-Key: sk-cm-your-key"

# Search memories
curl "http://localhost:8000/api/memories/search?q=san+francisco" \
  -H "X-API-Key: sk-cm-your-key"

# Delete a memory
curl -X DELETE http://localhost:8000/api/memories/{id} \
  -H "X-API-Key: sk-cm-your-key"

# Search entities
curl "http://localhost:8000/api/entities/search?q=google" \
  -H "X-API-Key: sk-cm-your-key"
```

## Architecture

```
                    ┌──────────────┐
                    │   Clients    │
                    │  SDK / MCP / │
                    │  Extension   │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Express    │
                    │   API (8000) │
                    └──┬───┬───┬──┘
                       │   │   │
              ┌────────┘   │   └────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Postgres │ │  Qdrant  │ │  Valkey  │
        │  (Prisma)│ │ (Vectors)│ │ (Cache)  │
        └──────────┘ └──────────┘ └──────────┘
              │
              ▼
        ┌──────────┐
        │ pg-boss  │
        │ (Jobs)   │
        └──────────┘
```

| Component | Purpose |
|-----------|---------|
| **Express API** | REST endpoints, auth, rate limiting |
| **PostgreSQL** | User data, memories (metadata), entities |
| **Qdrant** | Vector embeddings for semantic search |
| **Valkey** | Caching (lookups, embeddings), rate limiting, budget tracking |
| **pg-boss** | Background job queue (capture processing, webhook delivery) |

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register a new user |
| POST | `/api/auth/login` | Login, get JWT tokens |
| POST | `/api/auth/refresh` | Refresh access token |
| POST | `/api/auth/api-keys` | Create an API key |
| POST | `/api/memories/capture` | Capture memories from conversation |
| GET | `/api/memories/lookup` | Look up relevant memories by topic |
| GET | `/api/memories` | List all memories (paginated) |
| GET | `/api/memories/search` | Full-text search memories |
| DELETE | `/api/memories/:id` | Delete a memory |
| POST | `/api/memories/:id/feedback` | Submit feedback on a memory |
| GET | `/api/entities` | List extracted entities |
| GET | `/api/entities/graph` | Get entity relationship graph |
| GET | `/api/entities/graph/3d` | Get 3D graph data |
| GET | `/api/stats` | Get usage statistics |
| POST | `/api/user-webhooks` | Register a webhook |
| GET | `/api/extension/config` | Get extension configuration |

Full Swagger documentation available at `/api/docs` when the server is running.

## Self-Hosting

### Minimum Requirements

- 2 CPU cores, 4GB RAM
- Docker and Docker Compose
- An OpenAI API key (for `gpt-4o-mini` and `text-embedding-3-small`)

### Production Deployment

```bash
# Use the production compose file (includes nginx + SSL)
docker compose -f docker-compose.prod.yml up -d
```

The production setup includes:
- **nginx** reverse proxy with SSL (Let's Encrypt / Certbot)
- Health checks on all services
- Resource limits (CPU + memory)
- Only ports 80/443 exposed publicly

### Database Migrations

```bash
# Generate Prisma client
npx prisma generate

# Run migrations
npx prisma migrate deploy

# Open Prisma Studio (GUI)
npx prisma studio
```

## Comparison

> Accurate as of March 2026. Mem0: ~50K stars. Graphiti (Zep): ~20K stars.

| Feature | ConvoMem OSS | Mem0 OSS | Graphiti (Zep) | Letta |
|---------|-------------|----------|----------------|-------|
| **Deployable REST API** | ✅ Full server | ⚠️ SDK + basic server | ⚠️ Library only | ✅ |
| **Built-in auth + users** | ✅ JWT + API keys | ❌ | ❌ | ⚠️ Token only |
| **Docker Compose (one command)** | ✅ | ⚠️ Partial | ⚠️ Requires graph DB | ✅ |
| **Automatic fact extraction** | ✅ | ✅ | ✅ | ✅ |
| **Memory deduplication** | ✅ Topic key | ✅ LLM-driven | ✅ Entity resolution | ✅ |
| **Entity extraction** | ✅ | ✅ | ✅ | ❌ |
| **Entity graph** | ❌ Cloud only | ⚠️ Pro plan only | ✅ (FalkorDB/Neo4j) | ❌ |
| **Temporal reasoning** | ❌ Cloud only | ✅ Basic | ✅ Core feature | ❌ |
| **MCP server** | ✅ | ✅ (mem0-mcp) | ✅ (Graphiti MCP 1.0) | ⚠️ Community only |
| **Chrome extension** | ✅ | ✅ (OpenMemory) | ❌ | ❌ |
| **SDK** | Node.js | Python + Node.js | Python | Python + TypeScript |
| **Multi-LLM support** | ❌ OpenAI only | ✅ OpenAI, Anthropic, Groq, Ollama | ✅ OpenAI, Anthropic, Gemini, Ollama | ✅ Model-agnostic |
| **Self-hostable** | ✅ | ✅ | ✅ | ✅ |

**The key difference:** ConvoMem ships as a complete, ready-to-run service. Auth, background jobs, caching, webhooks, MCP server, and Chrome extension all work together out of the box with a single `docker compose up`. Mem0 OSS is a library — you build the server around it. Graphiti requires running and managing a separate graph database. ConvoMem is the only option that goes from zero to a fully functional memory API in under five minutes.

---

## Cloud Version

[ConvoMem Cloud](https://convomem.com) is a managed hosted version with additional capabilities on top of the open-source core.

### What Cloud adds

**Higher quality memories**
- Significantly higher extraction accuracy — fewer hallucinated or low-confidence facts stored
- Smarter deduplication — catches near-duplicates the OSS topic-key match misses
- Better relevance ranking — lookups return more useful context, less noise

**Richer knowledge graph**
- Entity relationship graph — people, places, organizations, and technologies linked across memories
- Visual graph explorer — interactive UI to browse and query your knowledge graph
- Workspace organization — separate memory spaces per project, client, or context

**For teams building AI products**
- Customer memory profiles — give every end-user of your product their own persistent memory. Attach memories to your customers, not just your own account
- Org-level multi-tenancy — isolated memory spaces per organization with role-based access (Owner / Admin / Developer)
- Conversation insights — automatically surface patterns and signals across customer conversations
- Trend analysis — track how topics evolve over time across thousands of conversations
- Audit logging — full access and modification trail for compliance
- Org webhooks — real-time events at the organization level for customer memory changes

**Managed infrastructure**
- No Postgres, Qdrant, or Valkey to run yourself
- High availability with uptime SLA
- Dedicated support

[Sign up for early access → convomem.com](https://convomem.com)

## Contributing

Contributions are welcome! Here's how:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please make sure tests pass before submitting:

```bash
npm test
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
