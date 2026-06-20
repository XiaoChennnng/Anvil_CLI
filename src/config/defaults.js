'use strict';

const DEFAULTS = {
  // 默认提供商: 'deepseek' | 'kimi' | 'openai' | 'anthropic' | 自定义
  // 注意: openai 和 anthropic 无预设模型，需通过 /model add 添加
  provider: 'deepseek',
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

  // 定价配置（元/千 tokens）
  pricing: {
    // DeepSeek
    'deepseek-v4-flash': { input: 0.001, output: 0.002 },
    'deepseek-v4-pro': { input: 0.003, output: 0.006 },
    // Kimi K2.x 系列
    'kimi-k2.5': { input: 0.004, cachedInput: 0.0007, output: 0.021 },
    'kimi-k2.6': { input: 0.0065, cachedInput: 0.0011, output: 0.027 },
    'kimi-k2.7-code': { input: 0.0065, cachedInput: 0.0013, output: 0.027 },
    'kimi-k2.7-code-highspeed': { input: 0.013, cachedInput: 0.0026, output: 0.054 },
    // Moonshot V1 系列
    'moonshot-v1-8k': { input: 0.002, output: 0.01 },
    'moonshot-v1-32k': { input: 0.005, output: 0.02 },
    'moonshot-v1-128k': { input: 0.01, output: 0.03 },
    'moonshot-v1-8k-vision-preview': { input: 0.002, output: 0.01 },
    'moonshot-v1-32k-vision-preview': { input: 0.005, output: 0.02 },
    'moonshot-v1-128k-vision-preview': { input: 0.01, output: 0.03 },
    // 注意：OpenAI 和 Anthropic 模型由用户自行添加，无预设定价
  },

  context: {
    // windowSize 不设置默认值，由模型探测决定
    // DeepSeek: 1_000_000, Kimi: 256_000, etc.
    windowSize: null,
    autoCompress: true,
    compressThresholds: { softWarn: 70, light: 80, medium: 90, heavy: 95, critical: 98 },
    keepRounds: { default: 8, explore: 4, implement: 10, debug: 12, review: 6 },
    fileContextMaxEntries: 30,
    fileContextMaxTokens: 15000,
    // 语义预算压缩配置（level='semantic' 模式）
    semanticBudget: {
      min: 10_000,            // 硬性下限 1w tokens
      max: 50_000,            // 硬性上限 5w tokens
      default: 30_000,        // 默认预算 3w tokens
      timeoutMs: 60_000,      // LLM 摘要超时
      fallbackToStringSummary: true,  // LLM 失败时降级到字符串截取
    },
  },

  mcpServers: {},

  // 联网搜索（支持多引擎：Bing、DuckDuckGo、SearXNG）
  webSearch: {
    enabled: true,
    defaultEngine: 'auto', // 'auto' | 'bing' | 'duckduckgo' | 'searxng'
    timeout: 15000,
    maxResults: 8,
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // 缓存配置
    cacheEnabled: true,
    cache: {
      maxSize: 100, // 最大缓存条目数
      ttl: 300000, // 缓存有效期（毫秒），默认 5 分钟
    },
    // 各引擎配置
    bing: {
      enabled: true,
      endpoint: 'https://www.bing.com/search',
    },
    duckduckgo: {
      enabled: true,
      endpoint: 'https://html.duckduckgo.com/html/',
    },
    searxng: {
      enabled: true,
      instance: null, // 自定义 SearXNG 实例 URL，如 'https://search.example.com'
    },
  },

  // 用户长期记忆（.anvil/Memory.md）
  memory: {
    fileName: 'Memory.md',
    maxTokens: 5000,        // 软上限，尽量不超
    autoLoad: true,         // 自动加载到 system prompt（Tier 1）
    autoInject: false,      // 默认不注入普通对话
    warnOnExceed: true,     // 超限时给 AI 警告
    template: `# Anvil Memory — 用户长期记忆

## 用户偏好
<!-- 用户的工作习惯、代码风格、工具偏好 -->

## 项目规则
<!-- 用户对当前项目的硬性要求 -->

## 常用约定
<!-- 命名规范、目录结构、API 选择 -->

## 待办事项
<!-- 需要长期跟踪的事项 -->
`,
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
