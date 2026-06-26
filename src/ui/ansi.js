'use strict';

// ANSI 转义序列处理工具，完整匹配 CSI/OSC/SCO 序列
const ANSI_PATTERN = /\x1b\[[0-9;]*[mHKhlA-Za-z=]|\x1b\?[0-9;]*[hl]|\x1b\][^\x07]*\x07|\x1b\\|\x1b\[\?1049[hl]|\x1b\[38;2;\d+;\d+;\d+m|\x1b\[48;2;\d+;\d+;\d+m/g;

// 计算字符串的可见长度（去除 ANSI 后计算，支持 CJK 双倍宽字符）
function visibleLength(str) {
  if (!str) {return 0;}
  const clean = str.replace(ANSI_PATTERN, '');
  let len = 0;
  for (let i = 0; i < clean.length; i++) {
    len += isCJK(clean[i]) ? 2 : 1;
  }
  return len;
}

// 按可见宽度截断字符串（支持 ANSI 序列）
function truncateToWidth(str, maxWidth, suffix = '...') {
  if (!str) {return '';}
  if (maxWidth <= 0) {return suffix;}

  const suffixWidth = visibleLength(suffix);
  const availableWidth = maxWidth - suffixWidth;
  if (availableWidth <= 0) {return suffix;}

  let result = '';
  let visible = 0;
  let i = 0;

  while (i < str.length) {
    if (str[i] === '\x1b') {
      // 跳过整个 ANSI 序列（包括 24-bit 真彩色）
      const match = str.slice(i).match(/^(\x1b\[[0-9;]*[mHKhlA-Za-z=]|\x1b\?[0-9;]*[hl]|\x1b\][^\x07]*\x07|\x1b\\|\x1b\[\?1049[hl]|\x1b\[38;2;\d+;\d+;\d+m|\x1b\[48;2;\d+;\d+;\d+m])/);
      if (match) {
        result += match[0];
        i += match[0].length;
        continue;
      }
    }

    const char = str[i];
    const charWidth = isCJK(char) ? 2 : 1;

    if (visible + charWidth > availableWidth) {
      result += suffix;
      break;
    }

    result += char;
    visible += charWidth;
    i++;
  }

  return result;
}

function isCJK(char) {
  if (!char || char.length === 0) {return false;}
  const code = char.charCodeAt(0);
  if (code < 0x1100) {return false;}
  return (code <= 0x115F) ||
    (code >= 0x2E80 && code <= 0xA4CF) ||
    (code >= 0xAC00 && code <= 0xD7AF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE10 && code <= 0xFE6F) ||
    (code >= 0xFF01 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) ||
    (code >= 0x3000 && code <= 0x303F);
}

module.exports = {
  visibleLength,
  truncateToWidth,
  isCJK,
};