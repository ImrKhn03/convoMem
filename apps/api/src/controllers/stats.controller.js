'use strict'
const statsService = require('../services/stats.service')
const { getRedis } = require('../config/redis')
const { DAILY_BUDGET_USD } = require('../services/capture.service')

async function getDashboard(req, res, next) {
  try {
    const stats = await statsService.getDashboardStats(req.userId)
    res.json(stats)
  } catch (err) {
    next(err)
  }
}

async function getOpenAIUsage(req, res, next) {
  try {
    const redis = getRedis()
    // Return last 7 days of spend
    const days = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
      const date = d.toISOString().slice(0, 10)
      const spent = parseFloat(await redis.get(`openai:daily:${date}`) || '0')
      days.push({ date, spent: parseFloat(spent.toFixed(6)) })
    }
    const today = days[0]
    res.json({
      today: { date: today.date, spent: today.spent, budget: DAILY_BUDGET_USD, budgetExceeded: today.spent >= DAILY_BUDGET_USD },
      last7Days: days,
    })
  } catch (err) {
    next(err)
  }
}

module.exports = { getDashboard, getOpenAIUsage }
