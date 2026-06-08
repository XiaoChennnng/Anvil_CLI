'use strict';

const chalk = require('chalk');

const DARK_COLORS = {
  background: '#212121',
  backgroundSecondary: '#252525',
  backgroundDarker: '#121212',
  text: '#e0e0e0',
  textMuted: '#6a6a6a',
  textEmphasized: '#e5c07b',
  primary: '#fab283',      // 橙/金 - AI 消息边框
  secondary: '#5c9cf5',    // 蓝 - 用户消息边框
  accent: '#9d7cd8',       // 紫
  error: '#e06c75',        // 红
  warning: '#f5a742',      // 橙
  success: '#7fd88f',      // 绿
  info: '#56b6c2',         // 青
  borderNormal: '#4b4c5c',
  borderFocused: '#fab283',
  borderDim: '#303030',
  // Diff 色（1:1 复刻 opencode）
  diffAdded: '#478247',
  diffRemoved: '#7C4444',
  diffContext: '#a0a0a0',
  diffHunkHeader: '#a0a0a0',
  diffAddedBg: '#303A30',
  diffRemovedBg: '#3A3030',
  diffHighlightAdded: '#DAFADA',
  diffHighlightRemoved: '#FADADD',
  diffContextBg: '#212121',
  diffAddedLineNumberBg: '#293229',
  diffRemovedLineNumberBg: '#332929',
  diffLineNumber: '#888888',
  // Markdown 色
  markdownText: '#e0e0e0',
  markdownHeading: '#5c9cf5',
  markdownLink: '#fab283',
  markdownLinkText: '#56b6c2',
  markdownCode: '#7fd88f',
  markdownBlockQuote: '#e5c07b',
  markdownEmph: '#e5c07b',
  markdownStrong: '#9d7cd8',
  markdownHorizontalRule: '#6a6a6a',
  markdownListItem: '#fab283',
  markdownListEnumeration: '#56b6c2',
  markdownCodeBlock: '#e0e0e0',
  markdownImage: '#fab283',
  markdownImageText: '#56b6c2',
  // 语法高亮色
  syntaxComment: '#6a6a6a',
  syntaxKeyword: '#5c9cf5',
  syntaxFunction: '#fab283',
  syntaxVariable: '#e06c75',
  syntaxString: '#7fd88f',
  syntaxNumber: '#9d7cd8',
  syntaxType: '#e5c07b',
  syntaxOperator: '#56b6c2',
  syntaxPunctuation: '#e0e0e0',
};

const LIGHT_COLORS = {
  background: '#f8f8f8',
  backgroundSecondary: '#f0f0f0',
  backgroundDarker: '#ffffff',
  text: '#2a2a2a',
  textMuted: '#8a8a8a',
  textEmphasized: '#b0851f',
  primary: '#3b7dd8',      // 蓝
  secondary: '#7b5bb6',    // 紫
  accent: '#d68c27',       // 橙
  error: '#d1383d',
  warning: '#d68c27',
  success: '#3d9a57',
  info: '#318795',
  borderNormal: '#d3d3d3',
  borderFocused: '#3b7dd8',
  borderDim: '#e5e5e6',
  // Diff 色（1:1 复刻 opencode）
  diffAdded: '#2E7D32',
  diffRemoved: '#C62828',
  diffContext: '#757575',
  diffHunkHeader: '#757575',
  diffAddedBg: '#E8F5E9',
  diffRemovedBg: '#FFEBEE',
  diffHighlightAdded: '#A5D6A7',
  diffHighlightRemoved: '#EF9A9A',
  diffContextBg: '#f8f8f8',
  diffAddedLineNumberBg: '#C8E6C9',
  diffRemovedLineNumberBg: '#FFCDD2',
  diffLineNumber: '#9E9E9E',
  markdownText: '#2a2a2a',
  markdownHeading: '#7b5bb6',
  markdownLink: '#3b7dd8',
  markdownLinkText: '#318795',
  markdownCode: '#3d9a57',
  markdownBlockQuote: '#b0851f',
  markdownEmph: '#b0851f',
  markdownStrong: '#d68c27',
  markdownHorizontalRule: '#8a8a8a',
  markdownListItem: '#3b7dd8',
  markdownListEnumeration: '#318795',
  markdownCodeBlock: '#2a2a2a',
  markdownImage: '#3b7dd8',
  markdownImageText: '#318795',
  syntaxComment: '#8a8a8a',
  syntaxKeyword: '#7b5bb6',
  syntaxFunction: '#3b7dd8',
  syntaxVariable: '#d1383d',
  syntaxString: '#3d9a57',
  syntaxNumber: '#d68c27',
  syntaxType: '#b0851f',
  syntaxOperator: '#318795',
  syntaxPunctuation: '#2a2a2a',
};

function createTheme(colors) {
  return {
    // 原始色值（供 ink 组件使用 hex 值）
    colors,

    // chalk 实例
    primary: chalk.hex(colors.primary),
    secondary: chalk.hex(colors.secondary),
    accent: chalk.hex(colors.accent),
    error: chalk.hex(colors.error),
    warning: chalk.hex(colors.warning),
    success: chalk.hex(colors.success),
    info: chalk.hex(colors.info),
    text: chalk.hex(colors.text),
    textMuted: chalk.hex(colors.textMuted),
    textEmphasized: chalk.hex(colors.textEmphasized),
    background: chalk.hex(colors.background),
    backgroundSecondary: chalk.hex(colors.backgroundSecondary),
    backgroundDarker: chalk.hex(colors.backgroundDarker),
    borderNormal: chalk.hex(colors.borderNormal),
    borderFocused: chalk.hex(colors.borderFocused),
    borderDim: chalk.hex(colors.borderDim),

    // 功能色：AI 思考内容灰色斜体（终端不支持则回退灰色）
    thinking: chalk.hex(colors.textMuted).italic,
    thinkingFallback: (text) => chalk.hex(colors.textMuted)(text),
    code: chalk.hex(colors.markdownCode),
    token: chalk.hex(colors.text),
    dim: chalk.dim,

    // 兼容旧接口
    user: chalk.hex(colors.secondary),
    assistant: chalk.hex(colors.primary),
    border: chalk.hex(colors.borderNormal),

    // Markdown 渲染色
    markdown: {
      text: chalk.hex(colors.markdownText),
      heading: chalk.hex(colors.markdownHeading).bold,
      link: chalk.hex(colors.markdownLink).underline,
      linkText: chalk.hex(colors.markdownLinkText).bold,
      code: chalk.hex(colors.markdownCode),
      blockquote: chalk.hex(colors.markdownBlockQuote).italic,
      strong: chalk.hex(colors.markdownStrong).bold,
      em: chalk.hex(colors.markdownEmph).italic,
      hr: chalk.hex(colors.markdownHorizontalRule),
      listItem: chalk.hex(colors.markdownListItem),
      listEnum: chalk.hex(colors.markdownListEnumeration),
      codeBlock: chalk.hex(colors.markdownCodeBlock),
      image: chalk.hex(colors.markdownImage).underline,
      imageText: chalk.hex(colors.markdownImageText).bold,
    },

    // 语法高亮色
    syntax: {
      comment: chalk.hex(colors.syntaxComment),
      keyword: chalk.hex(colors.syntaxKeyword),
      'function': chalk.hex(colors.syntaxFunction),
      variable: chalk.hex(colors.syntaxVariable),
      string: chalk.hex(colors.syntaxString),
      number: chalk.hex(colors.syntaxNumber),
      type: chalk.hex(colors.syntaxType),
      operator: chalk.hex(colors.syntaxOperator),
      punctuation: chalk.hex(colors.syntaxPunctuation),
    },

    // Diff 渲染色
    diff: {
      added: chalk.hex(colors.diffAdded),
      removed: chalk.hex(colors.diffRemoved),
      context: chalk.hex(colors.diffContext),
      hunkHeader: chalk.hex(colors.diffHunkHeader),
      addedBg: chalk.hex(colors.diffAddedBg),
      removedBg: chalk.hex(colors.diffRemovedBg),
      highlightAdded: chalk.hex(colors.diffHighlightAdded),
      highlightRemoved: chalk.hex(colors.diffHighlightRemoved),
      contextBg: chalk.hex(colors.diffContextBg),
      addedLineNumberBg: chalk.hex(colors.diffAddedLineNumberBg),
      removedLineNumberBg: chalk.hex(colors.diffRemovedLineNumberBg),
      lineNumber: chalk.hex(colors.diffLineNumber),
    },
  };
}

const DARK_THEME = createTheme(DARK_COLORS);
const LIGHT_THEME = createTheme(LIGHT_COLORS);

// 检测终端是否为暗色背景
function isDarkBackground() {
  // 简单检测：检查 COLORFGBG 环境变量
  const fgBg = process.env.COLORFGBG;
  if (fgBg) {
    const parts = fgBg.split(';');
    const bg = parseInt(parts[parts.length - 1], 10);
    return bg < 8;
  }
  return true; // 默认暗色
}

// 获取当前主题
function getTheme(preference = 'auto') {
  if (preference === 'light') {return LIGHT_THEME;}
  if (preference === 'dark') {return DARK_THEME;}
  return isDarkBackground() ? DARK_THEME : LIGHT_THEME;
}

module.exports = { getTheme, DARK_THEME, LIGHT_THEME, DARK_COLORS, LIGHT_COLORS };
