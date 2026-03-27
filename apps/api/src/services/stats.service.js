'use strict'
const { getDb } = require('../config/db')

async function getDashboardStats(userId) {
  const db = getDb()

  // Run all queries in parallel
  const [
    user,
    totalLookups,
    lookupsWithMemories,
    memoriesByCategory,
    monthlyGrowth,
    integrationCount,
  ] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { memoryCount: true } }),
    db.lookupLog.count({ where: { userId } }),
    db.lookupLog.findMany({ where: { userId }, select: { memoryIds: true } }),
    db.memory.groupBy({
      by: ['category'],
      where: { userId, supersededById: null },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    }),
    db.memory.findMany({
      where: {
        userId,
        createdAt: { gte: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) },
      },
      select: { createdAt: true },
    }),
    db.integration.count({ where: { userId, isActive: true } }),
  ])

  // Hit rate: % of lookups that returned ≥1 memory
  const lookupsWithHits = lookupsWithMemories.filter(l => l.memoryIds.length > 0).length
  const hitRate = totalLookups > 0 ? Math.round((lookupsWithHits / totalLookups) * 100) : 0

  // Memory growth: group by month label
  const monthMap = {}
  monthlyGrowth.forEach(m => {
    const label = m.createdAt.toLocaleString('en-US', { month: 'short', year: 'numeric' })
    monthMap[label] = (monthMap[label] || 0) + 1
  })
  // Build last 6 months in order
  const growth = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    const label = d.toLocaleString('en-US', { month: 'short', year: 'numeric' })
    growth.push({ month: label, count: monthMap[label] || 0 })
  }

  // Categories: normalize null to 'Uncategorized'
  const categories = memoriesByCategory.map(g => ({
    category: g.category || 'Uncategorized',
    count: g._count.id,
  }))

  return {
    totalMemories: user?.memoryCount || 0,
    hitRate,
    aiSessions: totalLookups,
    integrationsCount: integrationCount,
    memoriesByCategory: categories,
    memoryGrowth: growth,
  }
}

module.exports = { getDashboardStats }
