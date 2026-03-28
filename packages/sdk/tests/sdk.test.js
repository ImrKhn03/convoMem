'use strict';

const ConvoMem = require('../src/index');
const { ConvoMemError } = require('../src/errors');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock Response that resolves with the given body/status.
 * @param {object|null} body
 * @param {number} [status=200]
 */
function mockResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

/**
 * Install a one-shot fetch mock that returns the given response.
 */
function mockFetch(body, status = 200) {
  global.fetch = jest.fn().mockReturnValue(mockResponse(body, status));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('ConvoMem constructor', () => {
  test('throws when no apiKey is supplied', () => {
    expect(() => new ConvoMem({})).toThrow('apiKey is required');
  });

  test('throws when called with no arguments', () => {
    expect(() => new ConvoMem()).toThrow('apiKey is required');
  });

  test('instantiates successfully with a valid apiKey', () => {
    const client = new ConvoMem({ apiKey: 'sk-cm-test' });
    expect(client).toBeInstanceOf(ConvoMem);
  });

  test('accepts custom baseUrl and timeout', () => {
    const client = new ConvoMem({
      apiKey: 'sk-cm-test',
      baseUrl: 'https://api.example.com',
      timeout: 5000,
    });
    expect(client._client.baseUrl).toBe('https://api.example.com');
    expect(client._client.timeout).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// capture()
// ---------------------------------------------------------------------------

describe('capture()', () => {
  test('returns { status, jobId } on 202 Accepted', async () => {
    const payload = { status: 'queued', jobId: 'job-abc-123' };
    mockFetch(payload, 202);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.capture([
      { role: 'user', content: 'My name is Alice.' },
    ]);

    expect(result).toEqual(payload);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/memories/capture');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-Key']).toBe('sk-cm-test');

    const body = JSON.parse(init.body);
    expect(body.messages).toEqual([{ role: 'user', content: 'My name is Alice.' }]);
  });

  test('passes platform and filters when provided', async () => {
    mockFetch({ status: 'queued', jobId: 'job-xyz' }, 202);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    await sdk.capture(
      [{ role: 'user', content: 'Hello' }],
      { platform: 'slack', filters: { pii: true } }
    );

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.platform).toBe('slack');
    expect(body.filters).toEqual({ pii: true });
  });
});

// ---------------------------------------------------------------------------
// lookup()
// ---------------------------------------------------------------------------

describe('lookup()', () => {
  test('returns { context, memories, tokenCount }', async () => {
    const payload = {
      context: 'User prefers dark mode.',
      memories: [{ id: 'mem-1', content: 'User prefers dark mode.' }],
      tokenCount: 12,
    };
    mockFetch(payload);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.lookup('UI preferences');

    expect(result).toEqual(payload);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/memories/lookup');
    expect(url).toContain('topic=UI+preferences');
    expect(init.method).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

describe('search()', () => {
  test('returns { results, count }', async () => {
    const payload = {
      results: [{ id: 'mem-2', content: 'Alice lives in London.' }],
      count: 1,
    };
    mockFetch(payload);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.search('London');

    expect(result).toEqual(payload);

    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/memories/search');
    expect(url).toContain('q=London');
  });

  test('passes limit param when provided', async () => {
    mockFetch({ results: [], count: 0 });

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    await sdk.search('test query', { limit: 5 });

    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('limit=5');
  });
});

// ---------------------------------------------------------------------------
// listMemories()
// ---------------------------------------------------------------------------

describe('listMemories()', () => {
  test('returns { memories, total, page, pages }', async () => {
    const payload = {
      memories: [{ id: 'mem-3', content: 'Sample memory.' }],
      total: 1,
      page: 1,
      pages: 1,
    };
    mockFetch(payload);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.listMemories({ page: 1, limit: 20 });

    expect(result).toEqual(payload);

    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/memories');
    expect(url).toContain('page=1');
    expect(url).toContain('limit=20');
  });
});

// ---------------------------------------------------------------------------
// getMemory()
// ---------------------------------------------------------------------------

describe('getMemory()', () => {
  test('fetches a single memory by ID', async () => {
    const payload = { id: 'mem-99', content: 'Specific fact.' };
    mockFetch(payload);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.getMemory('mem-99');

    expect(result).toEqual(payload);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/memories/mem-99');
  });

  test('throws synchronously when id is missing', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    await expect(sdk.getMemory('')).rejects.toThrow('id is required');
  });
});

// ---------------------------------------------------------------------------
// deleteMemory()
// ---------------------------------------------------------------------------

describe('deleteMemory()', () => {
  test('issues a DELETE request', async () => {
    // 204 No Content — no body
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) })
    );

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.deleteMemory('mem-99');

    expect(result).toBeNull();
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/memories/mem-99');
    expect(init.method).toBe('DELETE');
  });
});

// ---------------------------------------------------------------------------
// lookupFeedback()
// ---------------------------------------------------------------------------

describe('lookupFeedback()', () => {
  test('posts feedback data', async () => {
    mockFetch({ success: true });

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const feedbackData = {
      memoryIds: ['mem-1', 'mem-2'],
      wasHelpful: true,
      topic: 'UI preferences',
    };
    const result = await sdk.lookupFeedback(feedbackData);

    expect(result).toEqual({ success: true });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/memories/lookup-feedback');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(feedbackData);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('ConvoMemError — error responses', () => {
  test('throws ConvoMemError with status 401 on Unauthorized', async () => {
    mockFetch({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);

    const sdk = new ConvoMem({ apiKey: 'bad-key' });
    await expect(sdk.listMemories()).rejects.toMatchObject({
      name: 'ConvoMemError',
      status: 401,
      code: 'AUTH_REQUIRED',
      message: 'Unauthorized',
    });
  });

  test('throws ConvoMemError with status 429 on rate limit (retries exhausted)', async () => {
    mockFetch({ error: 'Too Many Requests', code: 'RATE_LIMITED' }, 429);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test', maxRetries: 0 });
    await expect(sdk.search('flooding')).rejects.toMatchObject({
      name: 'ConvoMemError',
      status: 429,
      code: 'RATE_LIMITED',
    });
  });

  test('throws ConvoMemError with status 404 on missing resource', async () => {
    mockFetch({ error: 'Memory not found' }, 404);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    await expect(sdk.getMemory('does-not-exist')).rejects.toMatchObject({
      name: 'ConvoMemError',
      status: 404,
      message: 'Memory not found',
    });
  });

  test('falls back to generic message when error body has no .error field', async () => {
    mockFetch({}, 500);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    await expect(sdk.listMemories()).rejects.toMatchObject({
      name: 'ConvoMemError',
      status: 500,
      message: 'Request failed with status 500',
    });
  });

  test('throws ConvoMemError on network failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test', maxRetries: 0 });
    await expect(sdk.listMemories()).rejects.toMatchObject({
      name: 'ConvoMemError',
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });

  test('throws ConvoMemError with TIMEOUT code on abort', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(abortError);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test', timeout: 1, maxRetries: 0 });
    await expect(sdk.listMemories()).rejects.toMatchObject({
      name: 'ConvoMemError',
      status: 0,
      code: 'TIMEOUT',
    });
  });
});

// ---------------------------------------------------------------------------
// ConvoMemError class
// ---------------------------------------------------------------------------

describe('ConvoMemError', () => {
  test('is an instance of Error', () => {
    const err = new ConvoMemError('bad', 400, 'BAD_REQUEST');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConvoMemError);
    expect(err.name).toBe('ConvoMemError');
    expect(err.status).toBe(400);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('bad');
  });
});

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

describe('Retry logic', () => {
  /**
   * Build a mock Response with headers.get() support.
   * @param {object|null} body
   * @param {number} status
   * @param {Record<string,string>} [headers]
   */
  function mockRetryResponse(body, status, headers = {}) {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => headers[h] || null },
      json: () => Promise.resolve(body),
    });
  }

  test('retries on 429 and succeeds', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test', maxRetries: 2, retryDelay: 1 });
    global.fetch = jest.fn()
      .mockReturnValueOnce(mockRetryResponse({ error: 'Too Many Requests' }, 429))
      .mockReturnValueOnce(mockRetryResponse({ memories: [], total: 0, page: 1, pages: 1 }, 200));

    const result = await sdk.listMemories();
    expect(result.memories).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('retries on 502, 503, 504', async () => {
    for (const status of [502, 503, 504]) {
      jest.resetAllMocks();
      const sdk = new ConvoMem({ apiKey: 'sk-cm-test', maxRetries: 1, retryDelay: 1 });
      global.fetch = jest.fn()
        .mockReturnValueOnce(mockRetryResponse({ error: 'Server Error' }, status))
        .mockReturnValueOnce(mockRetryResponse({ ok: true }, 200));

      const result = await sdk.listMemories();
      expect(result.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    }
  });

  test('honors numeric Retry-After header', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test', maxRetries: 1, retryDelay: 5000 });
    const start = Date.now();
    global.fetch = jest.fn()
      .mockReturnValueOnce(mockRetryResponse({ error: 'rate limited' }, 429, { 'Retry-After': '1' }))
      .mockReturnValueOnce(mockRetryResponse({ ok: true }, 200));

    const result = await sdk.listMemories();
    expect(result.ok).toBe(true);
    // Should have used Retry-After=1 (1000ms) instead of retryDelay=5000ms
    expect(Date.now() - start).toBeLessThan(4000);
  }, 10000);

  test('uses exponential backoff when no Retry-After', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test', maxRetries: 2, retryDelay: 10 });
    global.fetch = jest.fn()
      .mockReturnValueOnce(mockRetryResponse({ error: 'Too Many Requests' }, 429))
      .mockReturnValueOnce(mockRetryResponse({ error: 'Too Many Requests' }, 429))
      .mockReturnValueOnce(mockRetryResponse({ ok: true }, 200));

    const result = await sdk.listMemories();
    expect(result.ok).toBe(true);
    // First retry: 10 * 2^0 = 10ms, second: 10 * 2^1 = 20ms
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('gives up after maxRetries', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test', maxRetries: 2, retryDelay: 1 });
    global.fetch = jest.fn()
      .mockReturnValue(mockRetryResponse({ error: 'Too Many Requests', code: 'RATE_LIMITED' }, 429));

    await expect(sdk.listMemories()).rejects.toMatchObject({
      name: 'ConvoMemError',
      status: 429,
    });
    // Initial + 2 retries = 3 calls
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('does NOT retry 401, 404, 400', async () => {
    for (const status of [401, 404, 400]) {
      jest.resetAllMocks();
      const sdk = new ConvoMem({ apiKey: 'sk-cm-test', maxRetries: 3, retryDelay: 1 });
      global.fetch = jest.fn().mockReturnValue(mockRetryResponse({ error: 'nope' }, status));

      await expect(sdk.listMemories()).rejects.toMatchObject({
        name: 'ConvoMemError',
        status,
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  });

  test('maxRetries=0 disables retry', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test', maxRetries: 0, retryDelay: 1 });
    global.fetch = jest.fn().mockReturnValue(mockRetryResponse({ error: 'rate limited' }, 429));

    await expect(sdk.listMemories()).rejects.toMatchObject({
      name: 'ConvoMemError',
      status: 429,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('retries on network error', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test', maxRetries: 1, retryDelay: 1 });
    global.fetch = jest.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockReturnValueOnce(mockRetryResponse({ ok: true }, 200));

    const result = await sdk.listMemories();
    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// addMemory()
// ---------------------------------------------------------------------------

describe('addMemory()', () => {
  test('sends POST /api/memories with content', async () => {
    mockFetch({ id: 'mem-new', content: 'Test fact' }, 201);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.addMemory('Test fact', { category: 'preference' });

    expect(result.id).toBe('mem-new');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/memories');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.content).toBe('Test fact');
    expect(body.category).toBe('preference');
  });

  test('throws on missing content', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    await expect(sdk.addMemory('')).rejects.toThrow('content is required');
  });
});

// ---------------------------------------------------------------------------
// updateMemory()
// ---------------------------------------------------------------------------

describe('updateMemory()', () => {
  test('sends PATCH /api/memories/:id', async () => {
    mockFetch({ id: 'mem-1', content: 'Updated' });

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.updateMemory('mem-1', { content: 'Updated' });

    expect(result.content).toBe('Updated');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/memories/mem-1');
    expect(init.method).toBe('PATCH');
  });

  test('throws on missing id', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    await expect(sdk.updateMemory('', {})).rejects.toThrow('id is required');
  });
});

// ---------------------------------------------------------------------------
// Graph methods
// ---------------------------------------------------------------------------

describe('Graph methods', () => {
  test('listEntities sends GET /api/entities', async () => {
    mockFetch({ entities: [], total: 0, page: 1, pages: 1 });

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.listEntities({ entityType: 'person' });

    expect(result.entities).toEqual([]);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/entities');
    expect(url).toContain('entityType=person');
    expect(init.method).toBe('GET');
  });

  test('getEntity sends GET /api/entities/:id', async () => {
    const entity = { id: 'ent-1', name: 'Alice', entityType: 'person' };
    mockFetch(entity);

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.getEntity('ent-1');

    expect(result.name).toBe('Alice');
    expect(global.fetch.mock.calls[0][0]).toContain('/api/entities/ent-1');
  });

  test('getEntity throws on missing id', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    await expect(sdk.getEntity('')).rejects.toThrow('id is required');
  });

  test('searchEntities sends GET /api/entities/search', async () => {
    mockFetch({ entities: [{ name: 'Google' }] });

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.searchEntities('Google', 5);

    expect(result.entities[0].name).toBe('Google');
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/entities/search');
    expect(url).toContain('q=Google');
    expect(url).toContain('limit=5');
  });

  test('searchEntities throws on missing query', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    await expect(sdk.searchEntities('')).rejects.toThrow('query is required');
  });

  test('deleteEntity sends DELETE /api/entities/:id', async () => {
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) })
    );

    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    const result = await sdk.deleteEntity('ent-1');

    expect(result).toBeNull();
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/entities/ent-1');
    expect(init.method).toBe('DELETE');
  });

  test('deleteEntity throws on missing id', async () => {
    const sdk = new ConvoMem({ apiKey: 'sk-cm-test' });
    await expect(sdk.deleteEntity('')).rejects.toThrow('id is required');
  });
});
