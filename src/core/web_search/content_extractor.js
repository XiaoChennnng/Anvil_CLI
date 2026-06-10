'use strict';

/**
 * 网页内容提取器 - 轻量级正文提取
 * 支持三种模式：article(智能提取文章)、text(纯文本)、html(清理后的HTML)
 */

// 需要移除的标签（低价值内容）
const REMOVE_TAGS = [
  'script',
  'style',
  'nav',
  'footer',
  'header',
  'aside',
  'advertisement',
  'iframe',
  'noscript',
  'svg',
  'canvas',
  'form',
  'input',
  'button',
  'select',
  'textarea',
];

// 可能包含正文的容器标签
const CONTENT_CANDIDATES = [
  'article',
  'main',
  'section',
  'div',
  'p',
];

// 内容区域的类名/id 特征
const CONTENT_INDICATORS = [
  'content',
  'article',
  'post',
  'entry',
  'body',
  'main',
  'text',
  'story',
];

// 噪声区域的类名/id 特征
const NOISE_INDICATORS = [
  'comment',
  'sidebar',
  'widget',
  'related',
  'recommend',
  'share',
  'social',
  'ad-',
  'ads-',
  'advertisement',
  'footer',
  'header',
  'nav',
  'menu',
  'breadcrumb',
  'tag',
  'category',
  'meta',
  'author',
];

/**
 * 解码 HTML 实体
 * @param {string} html
 * @returns {string}
 */
function decodeHtmlEntities(html) {
  if (!html) return '';

  const entities = {
    '&nbsp;': ' ',
    '&ensp;': ' ',
    '&emsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&lsquo;': "'",
    '&rsquo;': "'",
    '&hellip;': '...',
    '&mdash;': '—',
    '&ndash;': '–',
    '&bull;': '•',
  };

  let result = html;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replace(new RegExp(entity, 'g'), char);
  }

  // 处理数字实体 &#123;
  result = result.replace(/&#(\d+);/g, (_, code) => {
    const n = parseInt(code, 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : '';
  });

  // 处理十六进制实体 &#x7B;
  result = result.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    const n = parseInt(hex, 16);
    return Number.isFinite(n) ? String.fromCodePoint(n) : '';
  });

  return result;
}

/**
 * 移除指定标签及其内容
 * @param {string} html
 * @param {string[]} tags
 * @returns {string}
 */
function removeTags(html, tags) {
  let result = html;
  for (const tag of tags) {
    // 匹配 <tag ...>...</tag> 和 <tag ... />
    const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>|<${tag}[^>]*/?>`, 'gi');
    result = result.replace(regex, '');
  }
  return result;
}

/**
 * 移除 HTML 注释
 * @param {string} html
 * @returns {string}
 */
function removeComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 将 HTML 转为纯文本
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  return html
    .replace(/<\/?[a-z][^>]*>/gi, ' ') // 替换所有标签为空格
    .replace(/\s+/g, ' ') // 合并空白
    .trim();
}

/**
 * 清理 HTML 属性
 * @param {string} html
 * @returns {string}
 */
function cleanAttributes(html) {
  // 保留部分安全标签，移除所有属性
  const allowedTags = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'blockquote', 'code', 'pre'];

  let result = html;

  // 先处理允许的标签，保留 href 属性（对于 a 标签）
  for (const tag of allowedTags) {
    if (tag === 'a') {
      // 对于 a 标签，保留 href
      const regex = new RegExp(`<a\\b[^>]*?href=["']([^"']+)["'][^>]*>`, 'gi');
      result = result.replace(regex, '<a href="$1">');
    } else {
      // 其他标签移除所有属性
      const regex = new RegExp(`<(${tag})\\b[^>]*>`, 'gi');
      result = result.replace(regex, '<$1>');
    }
  }

  // 移除不允许标签的属性
  const tagRegex = /<([a-z][a-z0-9]*)\b[^>]*>/gi;
  result = result.replace(tagRegex, (match, tagName) => {
    if (!allowedTags.includes(tagName.toLowerCase())) {
      return `<${tagName}>`;
    }
    return match;
  });

  return result;
}

/**
 * 计算文本密度（文本长度 / HTML 长度）
 * @param {string} html
 * @returns {number}
 */
function calculateTextDensity(html) {
  const text = htmlToText(html);
  const textLength = text.length;
  const htmlLength = html.length;

  if (htmlLength === 0) return 0;

  return textLength / htmlLength;
}

/**
 * 计算内容得分（综合考虑文本密度、长度、关键词）
 * @param {string} html
 * @returns {number}
 */
function calculateContentScore(html) {
  const text = htmlToText(html);
  const textLength = text.length;

  if (textLength < 100) return 0; // 太短的内容忽略

  const density = calculateTextDensity(html);
  const lowerHtml = html.toLowerCase();

  // 内容指示器加分
  let indicatorScore = 0;
  for (const indicator of CONTENT_INDICATORS) {
    if (lowerHtml.includes(indicator)) {
      indicatorScore += 10;
    }
  }

  // 噪声指示器减分
  let noiseScore = 0;
  for (const noise of NOISE_INDICATORS) {
    if (lowerHtml.includes(noise)) {
      noiseScore += 5;
    }
  }

  // 标点符号密度（文章通常有更多标点）
  const punctuationCount = (text.match(/[。，；：""''（）【】]/g) || []).length;
  const punctuationScore = punctuationCount * 2;

  // 综合得分
  return density * textLength + indicatorScore - noiseScore + punctuationScore;
}

/**
 * 提取最可能是正文的区块
 * @param {string} html
 * @returns {string}
 */
function extractBestContentBlock(html) {
  let bestBlock = html;
  let bestScore = calculateContentScore(html);

  // 尝试从候选标签中找出最佳内容区块
  for (const tag of CONTENT_CANDIDATES) {
    const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    const matches = html.match(regex) || [];

    for (const block of matches) {
      const score = calculateContentScore(block);
      if (score > bestScore) {
        bestScore = score;
        bestBlock = block;
      }
    }
  }

  return bestBlock;
}

/**
 * 提取文章正文
 * @param {string} html
 * @returns {string}
 */
function extractArticle(html) {
  // 预处理
  let cleaned = removeComments(html);
  cleaned = removeTags(cleaned, REMOVE_TAGS);

  // 提取最佳内容区块
  const bestBlock = extractBestContentBlock(cleaned);

  // 转为文本
  let text = htmlToText(bestBlock);

  // 解码 HTML 实体
  text = decodeHtmlEntities(text);

  // 清理空白
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * 提取纯文本
 * @param {string} html
 * @returns {string}
 */
function extractText(html) {
  // 预处理
  let cleaned = removeComments(html);
  cleaned = removeTags(cleaned, REMOVE_TAGS);

  // 转为文本
  let text = htmlToText(cleaned);

  // 解码 HTML 实体
  text = decodeHtmlEntities(text);

  // 清理空白
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * 提取清理后的 HTML
 * @param {string} html
 * @returns {string}
 */
function extractHtml(html) {
  // 预处理
  let cleaned = removeComments(html);
  cleaned = removeTags(cleaned, REMOVE_TAGS);
  cleaned = cleanAttributes(cleaned);

  // 解码实体
  cleaned = decodeHtmlEntities(cleaned);

  // 清理空白
  cleaned = cleaned.replace(/>\s+</g, '><').trim();

  return cleaned;
}

/**
 * 主入口：提取网页内容
 * @param {string} html - 原始 HTML
 * @param {string} extractType - 提取类型：'article' | 'text' | 'html'
 * @param {number} maxLength - 最大返回长度
 * @returns {object} - { success: true, content, extractType, originalLength, extractedLength }
 */
function extractContent(html, extractType = 'article', maxLength = 8000) {
  if (!html || typeof html !== 'string') {
    return { error: 'HTML 内容不能为空' };
  }

  let content;

  switch (extractType) {
    case 'article':
      content = extractArticle(html);
      break;
    case 'text':
      content = extractText(html);
      break;
    case 'html':
      content = extractHtml(html);
      break;
    default:
      return { error: `不支持的提取类型: ${extractType}` };
  }

  const originalLength = content.length;

  // 截断到最大长度
  if (content.length > maxLength) {
    content = content.slice(0, maxLength) + '...(已截断)';
  }

  return {
    success: true,
    content,
    extractType,
    originalLength,
    extractedLength: content.length,
  };
}

module.exports = {
  extractContent,
  extractArticle,
  extractText,
  extractHtml,
  decodeHtmlEntities,
  calculateTextDensity,
};
