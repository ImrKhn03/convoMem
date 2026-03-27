'use strict';

const { QdrantClient } = require('@qdrant/js-client-rest');

const PERSONAL_COLLECTION = 'personal_memories';
const VECTOR_SIZE = 1536; // text-embedding-3-small

/** @type {QdrantClient} */
let client;

/**
 * Returns the Qdrant singleton client.
 * @returns {QdrantClient}
 */
function getQdrant() {
  if (!client) {
    client = new QdrantClient({
      url: process.env.QDRANT_URL || 'http://localhost:6333',
      apiKey: process.env.QDRANT_API_KEY || undefined,
      checkCompatibility: false,
    });
  }
  return client;
}

/**
 * Ensure the personal_memories collection exists.
 * Idempotent — safe to call on every startup.
 */
async function setupCollections() {
  const qdrant = getQdrant();

  const { collections } = await qdrant.getCollections();
  const exists = collections.some((c) => c.name === PERSONAL_COLLECTION);

  if (!exists) {
    await qdrant.createCollection(PERSONAL_COLLECTION, {
      vectors: {
        size: VECTOR_SIZE,
        distance: 'Cosine',
      },
      optimizers_config: {
        default_segment_number: 2,
      },
    });

    // Create payload index for userId filtering (required for tenant isolation)
    await qdrant.createPayloadIndex(PERSONAL_COLLECTION, {
      field_name: 'userId',
      field_schema: 'keyword',
    });
  }

  await ensureTextIndexes();
}

/**
 * Create text payload indexes on content and topicKey for keyword fallback search.
 * Idempotent — Qdrant silently succeeds if the index already exists.
 */
async function ensureTextIndexes() {
  const qdrant = getQdrant();

  // Prefix tokenizer on content — "lives" generates tokens ["live","lives"]
  await qdrant.createPayloadIndex(PERSONAL_COLLECTION, {
    field_name: 'content',
    field_schema: {
      type: 'text',
      tokenizer: 'prefix',
      min_token_len: 4,
      max_token_len: 15,
      lowercase: true,
    },
  });

  // Word tokenizer on topicKey — "dietary_preference" → ["dietary","preference"]
  await qdrant.createPayloadIndex(PERSONAL_COLLECTION, {
    field_name: 'topicKey',
    field_schema: {
      type: 'text',
      tokenizer: 'word',
      min_token_len: 3,
      max_token_len: 30,
      lowercase: true,
    },
  });

  // Text index on searchTags — word tokenizer for exact keyword matching
  await qdrant.createPayloadIndex(PERSONAL_COLLECTION, {
    field_name: 'searchTags',
    field_schema: {
      type: 'text',
      tokenizer: 'word',
      min_token_len: 3,
      max_token_len: 30,
      lowercase: true,
    },
  });
}

module.exports = { getQdrant, setupCollections, ensureTextIndexes, PERSONAL_COLLECTION };
