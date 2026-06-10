'use strict';

/**
 * web_search 工具单元测试
 *
 * 覆盖 4 个用例：
 * 1. success path — 解析真实 Bing HTML 片段并返回结构化结果
 * 2. 反爬检测 — HTML 含 "unusual traffic" 时返回 error
 * 3. 超时 — AbortError 映射为友好错误信息
 * 4. 配置禁用 — enabled=false 时返回 error
 *
 * 策略：mock globalThis.fetch 控制响应；parseBingHTML 直接测避免 mock。
 */

const { searchBing, parseBingHTML } = require('../../../src/core/web_search/bing');

// 简化的 Bing HTML 片段 fixture（含 2 条结果 + 1 条 Bing 重定向）
const BING_HTML_FIXTURE = `
<!DOCTYPE html>
<html><head><title>nodejs fetch - Search</title></head>
<body>
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://nodejs.org/api/globals.html">globalThis.fetch - Node.js Docs</a></h2>
    <div class="b_caption">
      <p>The fetch() method in Node.js implements the standard Web API for fetching resources.</p>
    </div>
  </li>
  <li class="b_algo">
    <h2><a href="https://developer.mozilla.org/en-US/docs/Web/API/fetch">fetch() - MDN</a></h2>
    <div class="b_caption">
      <p>The fetch() method starts the process of fetching a resource from the network.</p>
    </div>
  </li>
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&&u=https%3A%2F%2Fexample.com%2F">Bing Redirect</a></h2>
    <div class="b_caption"><p>This should be filtered out</p></div>
  </li>
</ol>
</body></html>
`;

const CAPTCHA_HTML = `
<!DOCTYPE html>
<html><body>
<div class="block">Sorry, we noticed unusual traffic from your network. Please complete the security check.</div>
</body></html>
`;

describe('parseBingHTML', () => {
  test('解析真实 HTML 片段并返回结构化结果（过滤 Bing 重定向）', () => {
    const { results, captcha } = parseBingHTML(BING_HTML_FIXTURE, 10);
    expect(captcha).toBe(false);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'globalThis.fetch - Node.js Docs',
      url: 'https://nodejs.org/api/globals.html',
      source: 'bing',
      position: 1,
    });
    expect(results[1].title).toContain('fetch() - MDN');
    expect(results[1].url).toBe('https://developer.mozilla.org/en-US/docs/Web/API/fetch');
    expect(results[1].position).toBe(2);
  });

  test('空 HTML 返回空数组', () => {
    const { results, captcha } = parseBingHTML('', 10);
    expect(results).toEqual([]);
    expect(captcha).toBe(false);
  });

  test('maxResults 限制返回数量', () => {
    const { results } = parseBingHTML(BING_HTML_FIXTURE, 1);
    expect(results).toHaveLength(1);
  });

  test('反爬关键词命中返回 captcha=true', () => {
    const { results, captcha } = parseBingHTML(CAPTCHA_HTML, 10);
    expect(captcha).toBe(true);
    expect(results).toEqual([]);
  });
});

describe('searchBing', () => {
  let originalFetch;
  let mockLogger;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  test('success path — 拿到结果并返回结构化对象', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => BING_HTML_FIXTURE,
    }));

    const result = await searchBing('nodejs fetch', { maxResults: 5, locale: 'zh-CN' }, mockLogger);

    expect(result.success).toBe(true);
    expect(result.query).toBe('nodejs fetch');
    expect(result.provider).toBe('bing');
    expect(result.totalResults).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].url).toBe('https://nodejs.org/api/globals.html');
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  test('反爬检测 — HTML 含 unusual traffic 时返回 error', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => CAPTCHA_HTML,
    }));

    const result = await searchBing('test', {}, mockLogger);

    expect(result.error).toBe('Bing 触发反爬验证，请稍后重试');
    expect(mockLogger.warn).toHaveBeenCalledWith('web_search 触发 Bing 反爬验证');
  });

  test('超时 — AbortError 映射为友好错误', async () => {
    globalThis.fetch = jest.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const result = await searchBing('test', { timeout: 100 }, mockLogger);

    expect(result.error).toMatch(/^搜索超时 \(100ms\)$/);
  });

  test('配置禁用 — enabled=false 时返回 error', async () => {
    const result = await searchBing('test', { enabled: false }, mockLogger);

    expect(result.error).toBe('web_search 工具未启用');
    // 禁用时不应该发请求
    expect(globalThis.fetch).toBe(originalFetch);
  });

  test('缺 query — 返回 error', async () => {
    const result = await searchBing('', {}, mockLogger);
    expect(result.error).toBe('query 参数必填');
  });

  test('HTTP 4xx — 返回带状态码的错误', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => '',
    }));

    const result = await searchBing('test', {}, mockLogger);
    expect(result.error).toBe('Bing 返回 403');
  });

  test('解析 0 结果 — 返回解析失败错误', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html><body>No results here, completely different structure</body></html>',
    }));

    const result = await searchBing('test', {}, mockLogger);
    expect(result.error).toBe('Bing 页面结构变化，解析失败');
  });
});
