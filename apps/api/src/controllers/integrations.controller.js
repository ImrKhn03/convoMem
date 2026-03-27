'use strict'

const { z } = require('zod')
const integrationsService = require('../services/integrations.service')
const { ValidationError } = require('../utils/errors')

const toggleSchema = z.object({
  isActive: z.boolean(),
})

/**
 * GET /api/integrations
 * Returns all supported platforms with their status and memory counts for the user.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function list(req, res, next) {
  try {
    const integrations = await integrationsService.listIntegrations(req.userId)
    res.json({
      integrations,
      active: integrations.filter(i => i.isActive).length,
      total:  integrations.length,
    })
  } catch (err) {
    next(err)
  }
}

/**
 * PATCH /api/integrations/:platform
 * Toggle an integration on or off.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function toggle(req, res, next) {
  try {
    const { platform } = req.params
    if (!platform || typeof platform !== 'string' || platform.trim() === '') {
      throw new ValidationError('platform parameter is required')
    }

    const input = toggleSchema.parse(req.body)

    const integration = await integrationsService.toggleIntegration(
      req.userId,
      platform.trim(),
      input.isActive
    )

    res.json({ integration })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, toggle }
