'use strict';

const DEFAULTS = {
  defaultModel: 'deepseek-v4-flash',
  baseURL: 'https://api.deepseek.com',
  thinkingMode: true,
  reasoningEffort: 'max',
  timeout: 60000,
  retryCount: 2,

  theme: 'auto',
  maxOutputLines: 50,

  configDirName: '.anvil',
  sessionsDirName: 'sessions',
  logsDirName: 'logs',

  pricing: {
    'deepseek-v4-flash': { input: 0.001, output: 0.002 },
    'deepseek-v4-pro': { input: 0.003, output: 0.006 },
  },

  context: {
    windowSize: 1_000_000,
    autoCompress: true,
    compressThresholds: { softWarn: 70, light: 80, medium: 90, heavy: 95, critical: 98 },
    keepRounds: { default: 8, explore: 4, implement: 10, debug: 12, review: 6 },
    fileContextMaxEntries: 30,
    fileContextMaxTokens: 15000,
  },

  mcpServers: {},

  // 联网搜索（默认 Bing 公开搜索页，零 key 模拟浏览器抓取）
  webSearch: {
    enabled: true,
    endpoint: 'https://www.bing.com/search',
    timeout: 15000,
    maxResults: 8,
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },

  i18n: {
    thinking: { zh: '正在思考...', en: 'Thinking...' },
    thinkingDone: { zh: '思考完成', en: 'Thinking complete' },
    confirmWrite: { zh: '确认写入', en: 'Confirm write' },
    confirmDelete: { zh: '确认删除', en: 'Confirm delete' },
    confirmExecute: { zh: '确认执行', en: 'Confirm execute' },
    yes: { zh: '是', en: 'Yes' },
    no: { zh: '否', en: 'No' },
    skip: { zh: '跳过', en: 'Skip' },
    edit: { zh: '编辑', en: 'Edit' },
    interrupt: { zh: '已中断', en: 'Interrupted' },
    error: { zh: '错误', en: 'Error' },
    tokenLabel: { zh: '本轮', en: 'this turn' },
    totalLabel: { zh: '总计', en: 'total' },
  },
};

module.exports = DEFAULTS;
