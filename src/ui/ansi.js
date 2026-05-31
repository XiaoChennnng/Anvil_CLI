'use strict';

/**
 * ANSI 转义序列处理工具
 * 使用正则表达式完整匹配 CSI、OSC、SCO 等各类 ANSI 序列
 */

// 完整的 ANSI CSI/OSC 序列正则
// 匹配：\x1b[...m (颜色等), \x1b[...H (光标位置), \x1b[...K (清除), \x1b[?...h/l (模式设置)
//      \x1b]... BEL (\x07), \x1b\\ (DCS), \x1b[?1049h/l (Alt screen)
//      \x1b[38;2;R;G;Bm (24-bit 真彩色前景), \x1b[48;2;R;G;Bm (24-bit 真彩色背景)
const ANSI_PATTERN = /\x1b\[[0-9;]*[mHKhlA-Za-z=]|\x1b\?[0-9;]*[hl]|\x1b\][^\x07]*\x07|\x1b\\|\x1b\[\?1049[hl]|\x1b\[38;2;\d+;\d+;\d+m|\x1b\[48;2;\d+;\d+;\d+m/g;

/**
 * 去除字符串中的所有 ANSI 转义序列
 * @param {string} str - 输入字符串
 * @returns {string} 去除 ANSI 后的纯文本
 */
function stripAnsi(str) {
  if (!str) {return '';}
  return str.replace(ANSI_PATTERN, '');
}

/**
 * 计算字符串的可见长度（去除 ANSI 后计算，支持 CJK 双倍宽字符）
 * @param {string} str - 输入字符串
 * @returns {number} 可见字符宽度
 */
function visibleLength(str) {
  if (!str) {return 0;}
  const clean = str.replace(ANSI_PATTERN, '');
  let len = 0;
  for (let i = 0; i < clean.length; i++) {
    len += isCJK(clean[i]) ? 2 : 1;
  }
  return len;
}

/**
 * 按可见宽度截断字符串（支持 ANSI 序列）
 * @param {string} str - 输入字符串
 * @param {number} maxWidth - 最大可见宽度
 * @param {string} suffix - 超长时的后缀，默认为 '...'
 * @returns {string} 截断后的字符串
 */
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

/**
 * 判断是否为 CJK 双倍宽字符
 * @param {string} char - 单个字符
 * @returns {boolean}
 */
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
  ANSI_PATTERN,
  visibleLength,
  truncateToWidth,
  isCJK,
};