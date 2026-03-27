'use strict';

// PII patterns to detect sensitive data
const PII_PATTERNS = [
  /\b\d{3}-?\d{2}-?\d{4}\b/g,                            // SSN
  /\b4[0-9]{12}(?:[0-9]{3})?\b/g,                        // Visa card
  /\b5[1-5][0-9]{14}\b/g,                                 // MasterCard
  /\b3[47][0-9]{13}\b/g,                                  // Amex
  /\b(?:\d[ -]*?){13,16}\b/g,                             // Generic card
  /\b[A-Z]{2}\d{6}[A-Z]?\b/g,                            // Passport number (basic)
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,                      // Phone number
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,        // Email
];

const SENSITIVE_KEYWORDS = [
  /\bpassword\b/i,
  /\bapi.?key\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\bcredit.?card\b/i,
  /\bssn\b/i,
  /\bsocial.?security\b/i,
];

/**
 * Filter an array of extracted facts, removing ones that contain PII
 * or sensitive keywords based on activeFilters.
 *
 * @param {Array<{ content: string, category?: string }>} facts
 * @param {{ pii?: boolean, keywords?: boolean }} [activeFilters]
 * @returns {{ safe: Array, filtered: Array }}
 */
function filterFacts(facts, activeFilters = { pii: true, keywords: false }) {
  const safe = [];
  const filtered = [];

  for (const fact of facts) {
    let isSensitive = false;

    if (activeFilters.pii) {
      for (const pattern of PII_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(fact.content)) {
          isSensitive = true;
          break;
        }
      }
    }

    if (!isSensitive && activeFilters.keywords) {
      for (const pattern of SENSITIVE_KEYWORDS) {
        if (pattern.test(fact.content)) {
          isSensitive = true;
          break;
        }
      }
    }

    if (isSensitive) {
      filtered.push({ ...fact, isSensitive: true });
    } else {
      safe.push(fact);
    }
  }

  return { safe, filtered };
}

/**
 * Check if a single string contains PII.
 * @param {string} text
 * @returns {boolean}
 */
function containsPII(text) {
  for (const pattern of PII_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

module.exports = { filterFacts, containsPII };
