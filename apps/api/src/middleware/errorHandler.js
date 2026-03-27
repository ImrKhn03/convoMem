'use strict';

const logger = require('../utils/logger');
const { AppError, ValidationError } = require('../utils/errors');

/**
 * Global Express error handler.
 * Must be registered last in app.js.
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Zod validation errors
  if (err.name === 'ZodError') {
    return res.status(422).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: err.errors,
    });
  }

  // Known operational errors
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, path: req.path }, 'Operational error');
    }

    const body = {
      error: err.message,
      code: err.code,
    };

    if (err instanceof ValidationError && err.details) {
      body.details = err.details;
    }

    return res.status(err.statusCode).json(body);
  }

  // Unknown errors
  logger.error({ err, path: req.path }, 'Unhandled error');
  return res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}

module.exports = { errorHandler };
