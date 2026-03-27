'use strict'

const { getDb } = require('../config/db')
const { ValidationError } = require('../utils/errors')

/** @type {Array<{ platform: string, label: string, description: string, comingSoon?: boolean }>} */
const SUPPORTED_PLATFORMS = [
  { platform: 'cursor',  label: 'Cursor IDE',      description: 'AI code editor' },
  { platform: 'claude',  label: 'Claude',           description: 'Anthropic Claude AI assistant' },
  { platform: 'chatgpt', label: 'ChatGPT',          description: 'OpenAI ChatGPT' },
  { platform: 'copilot', label: 'VS Code Copilot',  description: 'GitHub Copilot in VS Code' },
  { platform: 'gemini',  label: 'Google Gemini',    description: 'Google Gemini AI', comingSoon: true },
]

/**
 * Returns the set of supported platforms (read-only reference).
 * @returns {typeof SUPPORTED_PLATFORMS}
 */
function getSupportedPlatforms() {
  return SUPPORTED_PLATFORMS
}

/**
 * List all integrations for a user, merged with platform metadata and memory counts.
 *
 * @param {string} userId
 * @returns {Promise<Array<{
 *   platform: string,
 *   label: string,
 *   description: string,
 *   comingSoon: boolean,
 *   isActive: boolean,
 *   lastSyncAt: Date|null,
 *   memoriesCount: number
 * }>>}
 */
async function listIntegrations(userId) {
  const db = getDb()

  // Fetch all DB rows for this user and run per-platform memory counts in parallel
  const [dbRows, ...memoryCounts] = await Promise.all([
    db.integration.findMany({ where: { userId } }),
    ...SUPPORTED_PLATFORMS.map(p =>
      db.memory.count({ where: { userId, platform: p.platform } })
    ),
  ])

  // Index DB rows by platform for O(1) lookup
  /** @type {Map<string, object>} */
  const rowMap = new Map(dbRows.map(r => [r.platform, r]))

  return SUPPORTED_PLATFORMS.map((p, i) => {
    const row = rowMap.get(p.platform)
    return {
      platform:      p.platform,
      label:         p.label,
      description:   p.description,
      comingSoon:    p.comingSoon === true,
      isActive:      row ? row.isActive : false,
      lastSyncAt:    row ? row.lastSyncAt : null,
      memoriesCount: memoryCounts[i],
    }
  })
}

/**
 * Enable or disable an integration for a user.
 *
 * @param {string}  userId
 * @param {string}  platform
 * @param {boolean} isActive
 * @returns {Promise<{
 *   platform: string,
 *   label: string,
 *   description: string,
 *   comingSoon: boolean,
 *   isActive: boolean,
 *   lastSyncAt: Date|null,
 *   memoriesCount: number
 * }>}
 */
async function toggleIntegration(userId, platform, isActive) {
  const meta = SUPPORTED_PLATFORMS.find(p => p.platform === platform)

  if (!meta) {
    throw new ValidationError(`Unsupported platform: ${platform}`)
  }
  if (meta.comingSoon) {
    throw new ValidationError(`${meta.label} is coming soon and cannot be activated yet`)
  }

  const db = getDb()

  const now = new Date()

  const row = await db.integration.upsert({
    where:  { userId_platform: { userId, platform } },
    update: {
      isActive,
      updatedAt: now,
      ...(isActive ? { lastSyncAt: now } : {}),
    },
    create: {
      userId,
      platform,
      isActive,
      ...(isActive ? { lastSyncAt: now } : {}),
    },
  })

  const memoriesCount = await db.memory.count({ where: { userId, platform } })

  return {
    platform:      meta.platform,
    label:         meta.label,
    description:   meta.description,
    comingSoon:    false,
    isActive:      row.isActive,
    lastSyncAt:    row.lastSyncAt,
    memoriesCount,
  }
}

module.exports = { listIntegrations, toggleIntegration, getSupportedPlatforms }
