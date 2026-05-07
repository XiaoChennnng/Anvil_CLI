'use strict';

const SENSITIVE_PATTERNS = [
  {
    name: 'API_KEY',
    pattern: /sk-[a-zA-Z0-9]{20,}/g,
    replacement: '<ANVIL_REDACTED:API_KEY>',
  },
  {
    name: 'BEARER_TOKEN',
    pattern: /Bearer\s+[a-zA-Z0-9._\-+=]{20,}/g,
    replacement: '<ANVIL_REDACTED:TOKEN>',
  },
  {
    name: 'JWT_TOKEN',
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    replacement: '<ANVIL_REDACTED:TOKEN>',
  },
  {
    name: 'PRIVATE_KEY',
    pattern: /-----BEGIN( RSA| EC| DSA| OPENSSH|) PRIVATE KEY-----[^]*?-----END( RSA| EC| DSA| OPENSSH|) PRIVATE KEY-----/g,
    replacement: '<ANVIL_REDACTED:PRIVATE_KEY>',
  },
  {
    name: 'PASSWORD',
    pattern: /password\s*[=:]\s*["'][^"']+["']/gi,
    replacement: '<ANVIL_REDACTED:PASSWORD>',
  },
  {
    name: 'AWS_KEY',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '<ANVIL_REDACTED:API_KEY>',
  },
  {
    name: 'DB_URL',
    pattern: /(mongodb|mysql|postgresql|redis):\/\/[^:]+:[^@]+@/gi,
    replacement: (match) => {
      return match.replace(/\/\/[^:]+:[^@]+@/, '//<ANVIL_REDACTED:CREDENTIALS>@');
    },
  },
  {
    name: 'GITHUB_TOKEN',
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    replacement: '<ANVIL_REDACTED:TOKEN>',
  },
];

function detectAndReplace(text) {
  if (!text || typeof text !== 'string') {
    return { sanitized: text || '', detections: [] };
  }

  let sanitized = text;
  const detections = [];

  for (const rule of SENSITIVE_PATTERNS) {
    const matches = sanitized.match(rule.pattern);
    if (matches) {
      detections.push({
        type: rule.name,
        count: matches.length,
      });
      sanitized = sanitized.replace(rule.pattern, (match) => {
        if (typeof rule.replacement === 'function') {
          return rule.replacement(match);
        }
        return rule.replacement;
      });
    }
  }

  return { sanitized, detections };
}

function containsSensitiveContent(text) {
  const { detections } = detectAndReplace(text);
  return detections.length > 0;
}

module.exports = { detectAndReplace, containsSensitiveContent, SENSITIVE_PATTERNS };
