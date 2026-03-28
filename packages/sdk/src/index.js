'use strict';

const { HttpClient } = require('./client');

/**
 * Official ConvoMem SDK client.
 *
 * @example
 * const ConvoMem = require('convomem-sdk');
 * const client = new ConvoMem({ apiKey: 'sk-cm-...' });
 *
 * const { captureId } = await client.capture([
 *   { role: 'user', content: 'My name is Alice and I live in London.' },
 * ]);
 */
class ConvoMem {
  /**
   * @param {{ apiKey: string, baseUrl?: string, timeout?: number, maxRetries?: number, retryDelay?: number }} config
   */
  constructor({ apiKey, baseUrl, timeout, maxRetries, retryDelay } = {}) {
    if (!apiKey) throw new Error('apiKey is required');
    this._client = new HttpClient({ apiKey, baseUrl, timeout, maxRetries, retryDelay });
  }

  // ---------------------------------------------------------------------------
  // Memory Capture
  // ---------------------------------------------------------------------------

  /**
   * Submit conversation messages for async memory extraction.
   * The server enqueues a BullMQ job and returns immediately.
   *
   * @param {{ role: string, content: string }[]} messages
   *   Array of conversation turns (role must be 'user' | 'assistant' | 'system').
   * @param {{ platform?: string, filters?: { pii?: boolean } }} [opts]
   * @returns {Promise<{ status: string, captureId: string }>}
   */
  async capture(messages, opts = {}) {
    return this._client.post('/api/memories/capture', {
      messages,
      platform: opts.platform,
      filters: opts.filters,
    });
  }

  // ---------------------------------------------------------------------------
  // Memory Retrieval
  // ---------------------------------------------------------------------------

  /**
   * Retrieve relevant memories to inject as context for a given topic.
   *
   * @param {string} topic   Free-text topic or query string.
   * @returns {Promise<{ context: string, memories: Array<object>, tokenCount: number }>}
   */
  async lookup(topic) {
    return this._client.get('/api/memories/lookup', { topic });
  }

  /**
   * Full-text / semantic search across stored memories.
   *
   * @param {string} query
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<{ results: Array<object>, count: number }>}
   */
  async search(query, opts = {}) {
    return this._client.get('/api/memories/search', {
      q: query,
      limit: opts.limit,
    });
  }

  /**
   * Paginated list of all memories for the authenticated user.
   *
   * @param {{ page?: number, limit?: number }} [opts]
   * @returns {Promise<{ memories: Array<object>, total: number, page: number, pages: number }>}
   */
  async listMemories(opts = {}) {
    return this._client.get('/api/memories', opts);
  }

  /**
   * Fetch a single memory record by its ID.
   *
   * @param {string} id   UUID of the memory.
   * @returns {Promise<object>}
   */
  async getMemory(id) {
    if (!id) throw new Error('id is required');
    return this._client.get(`/api/memories/${id}`);
  }

  /**
   * Permanently delete a memory by ID.
   *
   * @param {string} id   UUID of the memory.
   * @returns {Promise<null>}
   */
  async deleteMemory(id) {
    if (!id) throw new Error('id is required');
    return this._client.request('DELETE', `/api/memories/${id}`);
  }

  /**
   * Poll until memories from a capture job are available, or timeout.
   *
   * @param {string} captureId   The captureId returned by `capture()`.
   * @param {{ pollIntervalMs?: number, timeoutMs?: number }} [opts]
   * @returns {Promise<{ captureId: string, status: string, count: number, memories: Array<object> }>}
   */
  async waitForCapture(captureId, { pollIntervalMs = 2000, timeoutMs = 60000 } = {}) {
    if (!captureId) throw new Error('captureId is required');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this._client.get(`/api/memories/capture/${captureId}`);
      if (result.status === 'complete') return result;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`waitForCapture timed out after ${timeoutMs}ms for captureId=${captureId}`);
  }

  // ---------------------------------------------------------------------------
  // Memory Management
  // ---------------------------------------------------------------------------

  /**
   * Manually add a memory.
   *
   * @param {string} content   The memory content.
   * @param {{ category?: string, memoryType?: string, topicKey?: string, platform?: string }} [opts]
   * @returns {Promise<object>}
   */
  async addMemory(content, opts = {}) {
    if (!content) throw new Error('content is required');
    return this._client.post('/api/memories', {
      content,
      category: opts.category,
      memoryType: opts.memoryType,
      topicKey: opts.topicKey,
      platform: opts.platform,
    });
  }

  /**
   * Update an existing memory by ID.
   *
   * @param {string} id     UUID of the memory.
   * @param {object} data   Fields to update.
   * @returns {Promise<object>}
   */
  async updateMemory(id, data) {
    if (!id) throw new Error('id is required');
    return this._client.patch(`/api/memories/${id}`, data);
  }

  // ---------------------------------------------------------------------------
  // Entities / Graph
  // ---------------------------------------------------------------------------

  /**
   * List entities for the authenticated user.
   *
   * @param {{ page?: number, limit?: number, entityType?: string }} [opts]
   * @returns {Promise<{ entities: Array<object>, total: number, page: number, pages: number }>}
   */
  async listEntities(opts = {}) {
    return this._client.get('/api/entities', opts);
  }

  /**
   * Fetch a single entity by ID.
   *
   * @param {string} id   UUID of the entity.
   * @returns {Promise<object>}
   */
  async getEntity(id) {
    if (!id) throw new Error('id is required');
    return this._client.get(`/api/entities/${id}`);
  }

  /**
   * Search entities by name or alias.
   *
   * @param {string} query
   * @param {number} [limit]
   * @returns {Promise<{ entities: Array<object> }>}
   */
  async searchEntities(query, limit) {
    if (!query) throw new Error('query is required');
    return this._client.get('/api/entities/search', { q: query, limit });
  }

  /**
   * Delete an entity by ID.
   *
   * @param {string} id   UUID of the entity.
   * @returns {Promise<null>}
   */
  async deleteEntity(id) {
    if (!id) throw new Error('id is required');
    return this._client.delete(`/api/entities/${id}`);
  }

  // ---------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------

  /**
   * Submit relevance feedback for a lookup response.
   * Used to improve future injection scoring.
   *
   * @param {{ memoryIds: string[], wasHelpful: boolean, topic: string }} data
   * @returns {Promise<object>}
   */
  async lookupFeedback(data) {
    return this._client.post('/api/memories/lookup-feedback', data);
  }
}

module.exports = ConvoMem;
module.exports.default = ConvoMem;
module.exports.ConvoMem = ConvoMem;
