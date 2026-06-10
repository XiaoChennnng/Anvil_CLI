'use strict';

const { search, getCacheStats, clearCache, SearchCache } = require('../../../../src/core/web_search');

describe('web_search/index', () => {
  beforeEach(() => {
    // 清空缓存
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  describe('search', () => {
    test('空 query 应该返回错误', async () => {
      const result = await search('', {}, { config: {} });
      expect(result.error).toContain('query');
    });

    test('搜索未启用应该返回错误', async () => {
      const result = await search('test', {}, {
        config: { webSearch: { enabled: false } }
      });
      expect(result.error).toContain('未启用');
    });

    test('只有空格的 query 应该返回错误', async () => {
      const result = await search('   ', {}, { config: {} });
      expect(result.error).toContain('query');
    });
  });

  describe('getCacheStats / clearCache', () => {
    test('初始缓存应该为空', () => {
      const stats = getCacheStats();
      expect(stats).toBeNull();
    });

    test('清空缓存后应该返回 null', () => {
      clearCache();
      const stats = getCacheStats();
      expect(stats).toBeNull();
    });
  });

  describe('SearchCache', () => {
    test('应该能独立使用 SearchCache', () => {
      const cache = new SearchCache({ maxSize: 10, defaultTTL: 60000 });
      cache.set('key1', { data: 'value' });
      expect(cache.get('key1')).toEqual({ data: 'value' });
      expect(cache.getStats().size).toBe(1);
      cache.clear();
    });
  });
});
