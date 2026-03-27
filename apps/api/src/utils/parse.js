'use strict';

/**
 * Parses a value if it's a JSON-encoded string, otherwise returns it as-is.
 * Useful for API tool builders that can't send native arrays/objects.
 *
 * @param {*} value
 * @returns {*} parsed value or original
 */
function parseIfString(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

module.exports = { parseIfString };
