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
    // 使用字符串方法处理，避免 [^]*? 在无 END 标记时的灾难性回溯
    pattern: null,
    replacement: '<ANVIL_REDACTED:PRIVATE_KEY>',
    useStringMethod: true,
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

/** 用字符串方法检测并替换 PRIVATE KEY 块（避免正则灾难性回溯） */
function _redactPrivateKeys(text) {
  const sanitized = text;
  let count = 0;
  let result = '';
  let lastPos = 0;
  let searchPos = 0;

  while (true) {
    const beginIdx = sanitized.indexOf('-----BEGIN', searchPos);
    if (beginIdx === -1) {break;}

    // 确认是 PRIVATE KEY 块（不是 CERTIFICATE 等）
    const afterBegin = sanitized.substring(beginIdx, beginIdx + 60);
    if (!afterBegin.includes('PRIVATE KEY-----')) {
      searchPos = beginIdx + 10;
      continue;
    }

    const endIdx = sanitized.indexOf('-----END', beginIdx + 10);
    if (endIdx === -1) {
      // 没有 END 标记，剩余内容直接追加
      result += sanitized.substring(lastPos);
      break;
    }

    // 确认 END 标记匹配
    const afterEnd = sanitized.substring(endIdx, endIdx + 60);
    if (!afterEnd.includes('PRIVATE KEY-----')) {
      searchPos = endIdx + 10;
      continue;
    }

    const keyEnd = sanitized.indexOf('-----', endIdx + 8);
    const blockEnd = keyEnd !== -1 ? keyEnd + 5 : endIdx + 30;

    result += sanitized.substring(lastPos, beginIdx);
    result += '<ANVIL_REDACTED:PRIVATE_KEY>';
    lastPos = blockEnd;
    searchPos = blockEnd;
    count++;
  }

  if (count === 0) {return { sanitized, count: 0 };}
  result += sanitized.substring(lastPos);
  return { sanitized: result, count };
}

function detectAndReplace(text) {
  if (!text || typeof text !== 'string') {
    return { sanitized: text || '', detections: [] };
  }

  let sanitized = text;
  const detections = [];

  for (const rule of SENSITIVE_PATTERNS) {
    if (rule.useStringMethod) {
      const { sanitized: s, count } = _redactPrivateKeys(sanitized);
      if (count > 0) {
        detections.push({ type: rule.name, count });
        sanitized = s;
      }
      continue;
    }

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

module.exports = { detectAndReplace, SENSITIVE_PATTERNS };
