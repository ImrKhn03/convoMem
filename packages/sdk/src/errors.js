'use strict';

/**
 * Error thrown by the ConvoMem SDK when the API returns a non-2xx response
 * or when a network/timeout failure occurs.
 */
class ConvoMemError extends Error {
  /**
   * @param {string} message   Human-readable description
   * @param {number} status    HTTP status code (0 for network errors)
   * @param {string} [code]    Machine-readable error code from the API
   */
  constructor(message, status, code) {
    super(message);
    this.name = 'ConvoMemError';
    this.status = status;
    this.code = code;
  }
}

module.exports = { ConvoMemError };
