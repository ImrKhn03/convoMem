# ConvoMem MCP Server

Model Context Protocol (MCP) server that exposes ConvoMem memory tools to Claude Desktop and Cursor.

## Prerequisites

- Node.js 18 or later
- ConvoMem API running (default: `http://localhost:8000`)
- A ConvoMem API key (see [Getting an API Key](#getting-an-api-key))

## Install

```bash
cd packages/mcp
npm install
```

## Claude Desktop Setup

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "convomem": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/src/index.js"],
      "env": {
        "CONVOMEM_API_KEY": "sk-ls-your-key-here",
        "CONVOMEM_BASE_URL": "http://localhost:8000"
      }
    }
  }
}
```

Replace `/absolute/path/to/packages/mcp/src/index.js` with the actual absolute path on your machine. Restart Claude Desktop after saving.

## Cursor Setup

**Project-level** — create `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "convomem": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/src/index.js"],
      "env": {
        "CONVOMEM_API_KEY": "sk-ls-your-key-here",
        "CONVOMEM_BASE_URL": "http://localhost:8000"
      }
    }
  }
}
```

**Global** — create `~/.cursor/mcp.json` with the same content to enable ConvoMem in all Cursor projects.

## Available Tools

### `convomem_capture`

Save facts from a conversation into ConvoMem memory. Call this at the end of a conversation or when the user says something worth remembering.

**Parameters:**
- `messages` (required) — array of `{ role: "user" | "assistant", content: string }` objects
- `platform` (optional) — platform hint: `mcp`, `chatgpt`, `claude`, `cursor`, `vscode`

**Example usage (in Claude/Cursor):**
> "Remember this conversation for me."

The assistant will call `convomem_capture` with the conversation messages and you will see a confirmation that the capture job was queued.

---

### `convomem_lookup`

Retrieve relevant memories for a topic to inject as context. Best called at the start of a conversation or before answering questions that may benefit from personal context.

**Parameters:**
- `topic` (required) — the topic or question to look up memories for

**Example usage:**
> "What do you remember about my diet preferences?"

---

### `convomem_search`

Search stored memories semantically. Use this to find specific facts shared in past conversations.

**Parameters:**
- `query` (required) — search query string
- `limit` (optional) — max results to return, 1–50 (default 20)

**Example usage:**
> "Search my memories for anything about my workout routine."

---

### `convomem_list`

List the most recent stored memories.

**Parameters:**
- `limit` (optional) — number of memories to return, 1–100 (default 20)
- `page` (optional) — page number for pagination (default 1)

**Example usage:**
> "Show me my recent memories."

---

## Getting an API Key

1. **Register** a ConvoMem account:
   ```bash
   curl -X POST http://localhost:8000/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email": "you@example.com", "password": "your-password", "name": "Your Name"}'
   ```

2. **Create an API key** (use the access token from registration):
   ```bash
   curl -X POST http://localhost:8000/api/auth/api-keys \
     -H "Authorization: Bearer <access_token>" \
     -H "Content-Type: application/json" \
     -d '{"name": "My MCP Key"}'
   ```

   The response includes your API key (e.g. `sk-ls-XXXXX`). Copy it — it is shown only once.

3. Set `CONVOMEM_API_KEY` to this value in your MCP config.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CONVOMEM_API_KEY` | Yes | — | ConvoMem API key (`sk-ls-...`) |
| `CONVOMEM_BASE_URL` | No | `http://localhost:8000` | Base URL of the ConvoMem API |
