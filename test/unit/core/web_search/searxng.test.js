'use strict';

const {
  parseSearXNGResponse,
  buildSearchUrl,
} = require('../../../../src/core/web_search/searxng');

describe('searxng', () => {
  describe('parseSearXNGResponse', () => {
    test('应该解析标准 JSON 响应', () => {
      const json = JSON.stringify({
        results: [
          { title: 'Result 1', url: 'https://1.com', content: 'Snippet 1', engine: 'google' },
          { title: 'Result 2', url: 'https://2.com', content: 'Snippet 2', engine: 'bing' },
        ],
      });
      const result = parseSearXNGResponse(json, 8);
      expect(result.error).toBeNull();
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual({
        title: 'Result 1',
        url: 'https://1.com',
        snippet: 'Snippet 1',
        source: 'google',
        position: 1,
      });
    });

    test('应该处理 abstract 字段', () => {
      const json = JSON.stringify({
        results: [{ title: 'Test', url: 'https://test.com', abstract: 'Abstract text' }],
      });
      const result = parseSearXNGResponse(json, 8);
      expect(result.results[0].snippet).toBe('Abstract text');
    });

    test('应该遵守 maxResults 限制', () => {
      const json = JSON.stringify({
        results: [
          { title: '1', url: 'https://1.com', content: '1' },
          { title: '2', url: 'https://2.com', content: '2' },
          { title: '3', url: 'https://3.com', content: '3' },
        ],
      });
      const result = parseSearXNGResponse(json, 2);
      expect(result.results).toHaveLength(2);
    });

    test('应该过滤掉无效结果（无 title 或 url）', () => {
      const json = JSON.stringify({
        results: [
          { title: 'Valid', url: 'https://valid.com', content: 'Valid snippet' },
          { title: '', url: 'https://invalid.com', content: 'Invalid' },
          { title: 'Invalid', url: '', content: 'Invalid' },
        ],
      });
      const result = parseSearXNGResponse(json, 8);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].title).toBe('Valid');
    });

    test('空 results 应该返回空数组', () => {
      const json = JSON.stringify({ results: [] });
      const result = parseSearXNGResponse(json, 8);
      expect(result.results).toEqual([]);
      expect(result.error).toBeNull();
    });

    test('缺少 results 字段应该返回错误', () => {
      const json = JSON.stringify({ query: 'test' });
      const result = parseSearXNGResponse(json, 8);
      expect(result.error).toContain('格式错误');
    });

    test('非法 JSON 应该返回错误', () => {
      const result = parseSearXNGResponse('invalid json', 8);
      expect(result.error).toContain('解析');
      expect(result.error).toContain('失败');
    });
  });

  describe('buildSearchUrl', () => {
    test('应该构建基本搜索 URL', () => {
      const url = buildSearchUrl('https://search.example.com', 'test query');
      expect(url).toContain('https://search.example.com/search');
      expect(url).toContain('q=test+query');
      expect(url).toContain('format=json');
    });

    test('应该包含语言参数', () => {
      const url = buildSearchUrl('https://search.example.com', 'test', { locale: 'en-US' });
      expect(url).toContain('language=en-US');
    });

    test('应该支持时间范围过滤', () => {
      const url = buildSearchUrl('https://search.example.com', 'test', { timeRange: 'week' });
      expect(url).toContain('time_range=week');
    });

    test('应该支持站点过滤', () => {
      const url = buildSearchUrl('https://search.example.com', 'test', { siteFilter: 'github.com' });
      expect(url).toContain('site%3Agithub.com');
    });

    test('应该处理特殊字符', () => {
      const url = buildSearchUrl('https://search.example.com', 'hello world');
      expect(url).toContain('q=');
      expect(url).not.toContain(' '); // 空格应该被编码为 + 或 %20
      expect(url).toContain('format=json'); // 参数分隔
    });
  });
});
