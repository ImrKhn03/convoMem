'use strict';

const { getDb } = require('../config/db');
const { callLLM, safeParse, isBudgetExceeded } = require('./capture.service');
const logger = require('../utils/logger');

const VALID_ENTITY_TYPES = new Set(['person', 'organization', 'location', 'technology', 'project', 'product', 'other']);

const ENTITY_TYPE_COLORS = {
  person:       '#4FC3F7',
  organization: '#81C784',
  location:     '#FFB74D',
  technology:   '#BA68C8',
  project:      '#FF8A65',
  product:      '#4DB6AC',
  other:        '#90A4AE',
};

async function extractEntitiesFromFacts(facts) {
  if (await isBudgetExceeded()) {
    logger.warn('Entity extraction skipped — daily budget exceeded');
    return null;
  }

  const factsText = facts.map((f) => `- ${f.content}`).join('\n');
  const result = await callLLM([
    {
      role: 'user',
      content: `Extract entities and relationships from these memory facts about a user.

Entity types: person, organization, location, technology, project, product, other

Rules:
- Use canonical names (e.g. "Google" not "google" or "Google LLC")
- Include aliases for common variants (e.g. ["google llc", "alphabet"])
- Relationships should be directional (from → to) with a short relationType label
- If a fact mentions WHEN a relationship started or ended, include validFrom/validUntil as ISO date strings
- If no temporal information is stated, omit these fields (do not guess)

Facts:
${factsText}

Return JSON:
{
  "entities": [{ "name": "Google", "type": "organization", "aliases": ["google llc"] }],
  "relationships": [{ "from": "User", "to": "Google", "type": "works_at", "validFrom": "2020-01-01T00:00:00Z" }]
}

Return {"entities":[],"relationships":[]} if no entities found.`,
    },
  ]);

  if (!result) return null;

  try {
    const parsed = safeParse(result);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
    };
  } catch {
    logger.error({ raw: result }, 'Failed to parse entity extraction result');
    return null;
  }
}

async function resolveEntity(userId, name, entityType, aliases = []) {
  const db = getDb();
  const type = VALID_ENTITY_TYPES.has(entityType) ? entityType : 'other';
  const lowerAliases = aliases.map((a) => a.toLowerCase());

  const existing = await db.entity.findFirst({
    where: {
      userId,
      OR: [
        { name: { equals: name, mode: 'insensitive' } },
        { aliases: { hasSome: [name.toLowerCase()] } },
      ],
    },
  });

  if (existing) {
    const currentAliases = new Set(existing.aliases);
    const toAdd = lowerAliases.filter((a) => !currentAliases.has(a));
    if (!currentAliases.has(name.toLowerCase())) toAdd.push(name.toLowerCase());

    if (toAdd.length > 0) {
      return db.entity.update({
        where: { id: existing.id },
        data: { aliases: { push: toAdd } },
      });
    }
    return existing;
  }

  return db.entity.create({
    data: {
      userId,
      name,
      entityType: type,
      aliases: lowerAliases,
    },
  });
}

async function linkEntitiesToMemories(entityId, memoryIds) {
  const db = getDb();
  await db.entityMention.createMany({
    data: memoryIds.map((memoryId) => ({ entityId, memoryId })),
    skipDuplicates: true,
  });
}

async function saveRelationships(userId, rels) {
  const db = getDb();
  for (const rel of rels) {
    try {
      const validFrom = rel.validFrom ? new Date(rel.validFrom) : null;
      const validUntil = rel.validUntil ? new Date(rel.validUntil) : null;
      const safeValidFrom = validFrom && !isNaN(validFrom.getTime()) ? validFrom : null;
      const safeValidUntil = validUntil && !isNaN(validUntil.getTime()) ? validUntil : null;

      const updateData = { confidence: { increment: 0.1 } };
      if (safeValidFrom) updateData.validFrom = safeValidFrom;
      if (safeValidUntil) updateData.validUntil = safeValidUntil;

      await db.relationship.upsert({
        where: {
          userId_fromEntityId_toEntityId_relationType: {
            userId,
            fromEntityId: rel.fromEntityId,
            toEntityId: rel.toEntityId,
            relationType: rel.type,
          },
        },
        create: {
          userId,
          fromEntityId: rel.fromEntityId,
          toEntityId: rel.toEntityId,
          relationType: rel.type,
          confidence: 0.8,
          sourceMemoryId: rel.sourceMemoryId || null,
          validFrom: safeValidFrom,
          validUntil: safeValidUntil,
        },
        update: updateData,
      });

      await db.relationship.updateMany({
        where: {
          userId,
          fromEntityId: rel.fromEntityId,
          toEntityId: rel.toEntityId,
          relationType: rel.type,
          confidence: { gt: 1.0 },
        },
        data: { confidence: 1.0 },
      });
    } catch (err) {
      logger.error({ err, rel }, 'Failed to save relationship');
    }
  }
}

async function extractAndSave(userId, savedMemories) {
  try {
    const extracted = await extractEntitiesFromFacts(savedMemories);
    if (!extracted || (extracted.entities.length === 0 && extracted.relationships.length === 0)) {
      return;
    }

    const entityMap = new Map();
    for (const ent of extracted.entities) {
      try {
        const resolved = await resolveEntity(userId, ent.name, ent.type, ent.aliases || []);
        entityMap.set(ent.name, resolved);
      } catch (err) {
        logger.error({ err, entity: ent.name }, 'Failed to resolve entity');
      }
    }

    const memoryIds = savedMemories.map((m) => m.id);
    for (const [, entity] of entityMap) {
      try {
        await linkEntitiesToMemories(entity.id, memoryIds);
      } catch (err) {
        logger.error({ err, entityId: entity.id }, 'Failed to link entity to memories');
      }
    }

    const resolvedRels = [];
    for (const rel of extracted.relationships) {
      const fromEntity = entityMap.get(rel.from);
      const toEntity = entityMap.get(rel.to);
      if (fromEntity && toEntity) {
        resolvedRels.push({
          fromEntityId: fromEntity.id,
          toEntityId: toEntity.id,
          type: rel.type,
          sourceMemoryId: savedMemories[0]?.id || null,
          validFrom: rel.validFrom || null,
          validUntil: rel.validUntil || null,
        });
      }
    }
    if (resolvedRels.length > 0) {
      await saveRelationships(userId, resolvedRels);
    }

    logger.info(
      { userId, entities: entityMap.size, relationships: resolvedRels.length },
      'Entity extraction complete'
    );
  } catch (err) {
    logger.error({ err, userId }, 'extractAndSave failed');
  }
}

async function getEntities(userId, { page = 1, limit = 20, entityType } = {}) {
  const db = getDb();
  const where = { userId };
  if (entityType && VALID_ENTITY_TYPES.has(entityType)) {
    where.entityType = entityType;
  }

  const [entities, total] = await Promise.all([
    db.entity.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { _count: { select: { mentions: true, fromRels: true, toRels: true } } },
    }),
    db.entity.count({ where }),
  ]);

  return { entities, total, page, pages: Math.ceil(total / limit) || 1 };
}

async function getEntity(userId, entityId) {
  const db = getDb();
  const entity = await db.entity.findFirst({
    where: { id: entityId, userId },
    include: {
      mentions: { include: { memory: { select: { id: true, content: true, category: true, createdAt: true } } } },
      fromRels: { include: { toEntity: { select: { id: true, name: true, entityType: true } } } },
      toRels: { include: { fromEntity: { select: { id: true, name: true, entityType: true } } } },
    },
  });
  return entity;
}

function buildTemporalFilter(asOf) {
  if (!asOf) return {};
  const asOfDate = new Date(asOf);
  return {
    AND: [
      { OR: [{ validFrom: null }, { validFrom: { lte: asOfDate } }] },
      { OR: [{ validUntil: null }, { validUntil: { gte: asOfDate } }] },
    ],
  };
}

async function searchEntities(userId, query, limit = 10) {
  const db = getDb();
  return db.entity.findMany({
    where: {
      userId,
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { aliases: { hasSome: [query.toLowerCase()] } },
      ],
    },
    take: limit,
    orderBy: { updatedAt: 'desc' },
  });
}

async function deleteEntity(userId, entityId) {
  const db = getDb();
  const entity = await db.entity.findFirst({ where: { id: entityId, userId } });
  if (!entity) return null;
  await db.entity.delete({ where: { id: entityId } });
  return entity;
}

module.exports = {
  extractEntitiesFromFacts,
  resolveEntity,
  linkEntitiesToMemories,
  saveRelationships,
  extractAndSave,
  getEntities,
  getEntity,
  searchEntities,
  deleteEntity,
  ENTITY_TYPE_COLORS,
};
