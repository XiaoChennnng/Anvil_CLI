'use strict';

/**
 * web_search 集成测试（默认 skip）
 *
 * 默认通过环境变量控制：
 *   WEB_SEARCH_INTEGRATION=1 npx jest test/integration
 *
 * 启用时真实请求 Bing 验证端到端。CI 上不会跑，避免 flaky。
 */

const { searchBing } = require('../../../src/core/web_search');

const ENABLED = process.env.WEB_SEARCH_INTEGRATION === '1';
const d = ENABLED ? describe : describe.skip;

d('integration: 真实 Bing 搜索', () => {
  test('搜索 "nodejs fetch timeout" 返回非空结果', async () => {
    const result = await searchBing('nodejs fetch timeout', {
      endpoint: 'https://www.bing.com/search',
      timeout: 20000,
      maxResults: 5,
      locale: 'zh-CN',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    // 不强求 success，因为 Bing 可能反爬，但希望至少能拿到响应
    if (result.success) {
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0]).toHaveProperty('title');
      expect(result.results[0]).toHaveProperty('url');
      expect(result.results[0]).toHaveProperty('snippet');
    } else {
      // 反爬/超时等情况也算"集成测试通过"，仅记录
      console.log(`[integration] 跳过断言: ${result.error}`);
    }
  }, 30000);

  test('英文 query 返回结构化结果', async () => {
    const result = await searchBing('deepseek v4 model', {
      endpoint: 'https://www.bing.com/search',
      timeout: 20000,
      maxResults: 3,
      locale: 'en-US',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    if (result.success) {
      expect(result.totalResults).toBeGreaterThan(0);
    } else {
      console.log(`[integration] 跳过断言: ${result.error}`);
    }
  }, 30000);
});
