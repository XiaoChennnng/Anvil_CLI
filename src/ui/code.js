'use strict';

const { highlight } = require('cli-highlight');

function formatCode(code, language) {
  try {
    const options = {
      ignoreIllegals: true,
    };
    if (language && language !== 'auto') {
      options.language = language;
    }

    const highlighted = highlight(code, options);

    // 移除 cli-highlight 可能添加的语言标签行
    return highlighted.replace(/^\/\/\s*language:\s*\S+\s*\n/gm, '').trimEnd();
  } catch {
      return code;
  }
}

function containsCode(text) {
  return /```[\s\S]*?```/.test(text);
}

function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      language: match[1] || 'auto',
      code: match[2],
    });
  }

  return blocks;
}

module.exports = { formatCode, containsCode, extractCodeBlocks };
