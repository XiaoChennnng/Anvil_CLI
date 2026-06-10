'use strict';

const { SearchCache } = require('../../../../src/core/web_search/cache');

describe('SearchCache', () => {
  let cache;

  beforeEach(() => {
    cache = new SearchCache({ maxSize: 5, defaultTTL: 1000 });
  });

  afterEach(() => {
    cache.clear();
  });

  describe('buildKey', () => {
    test('应该正确构建基础 key', () => {
      const key = SearchCache.buildKey('React', 'bing');
      expect(key).toBe('websearch:bing:any:any:react');
    });

    test('应该处理大小写（转为小写）', () => {
      const key = SearchCache.buildKey('ReAcT', 'BING');
      expect(key).toBe('websearch:bing:any:any:react');
    });

    test('应该处理空格（trim）', () => {
      const key = SearchCache.buildKey('  React  ', 'bing');
      expect(key).toBe('websearch:bing:any:any:react');
    });

    test('应该包含时间范围和站点过滤', () => {
      const key = SearchCache.buildKey('React', 'duckduckgo', 'week', 'github.com');
      expect(key).toBe('websearch:duckduckgo:week:github.com:react');
    });
  });

  describe('set/get', () => {
    test('应该能存储和获取数据', () => {
      cache.set('key1', { results: ['a', 'b'] });
      const result = cache.get('key1');
      expect(result).toEqual({ results: ['a', 'b'] });
    });

    test('获取不存在的 key 应该返回 null', () => {
      const result = cache.get('nonexistent');
      expect(result).toBeNull();
    });

    test('应该支持自定义 TTL', async () => {
      cache.set('key1', { data: 'value' }, 50); // 50ms 过期
      expect(cache.get('key1')).toEqual({ data: 'value' });

      await new Promise(resolve => setTimeout(resolve, 60));
      expect(cache.get('key1')).toBeNull();
    });
  });

  describe('LRU 淘汰', () => {
    test('超过 maxSize 应该淘汰最旧的条目', () => {
      cache.set('key1', { data: 1 });
      cache.set('key2', { data: 2 });
      cache.set('key3', { data: 3 });
      cache.set('key4', { data: 4 });
      cache.set('key5', { data: 5 });
      cache.set('key6', { data: 6 }); // 超出限制，key1 应该被淘汰

      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toEqual({ data: 2 });
      expect(cache.get('key6')).toEqual({ data: 6 });
    });

    test('访问条目应该更新其新鲜度', () => {
      cache.set('key1', { data: 1 });
      cache.set('key2', { data: 2 });
      cache.set('key3', { data: 3 });
      cache.set('key4', { data: 4 });
      cache.set('key5', { data: 5 });

      // 访问 key1，使其变为最新
      cache.get('key1');

      // 新增 key6，应该淘汰 key2（现在最旧）
      cache.set('key6', { data: 6 });

      expect(cache.get('key1')).toEqual({ data: 1 }); // key1 应该还在
      expect(cache.get('key2')).toBeNull(); // key2 被淘汰
    });
  });

  describe('TTL 过期', () => {
    test('过期后应该无法获取', async () => {
      cache.set('key1', { data: 'value' }, 50);

      await new Promise(resolve => setTimeout(resolve, 60));

      const result = cache.get('key1');
      expect(result).toBeNull();
    });

    test('过期后 has 应该返回 false', async () => {
      cache.set('key1', { data: 'value' }, 50);

      await new Promise(resolve => setTimeout(resolve, 60));

      expect(cache.has('key1')).toBe(false);
    });
  });

  describe('delete', () => {
    test('应该能删除指定 key', () => {
      cache.set('key1', { data: 'value' });
      expect(cache.get('key1')).not.toBeNull();

      cache.delete('key1');
      expect(cache.get('key1')).toBeNull();
    });

    test('删除不存在的 key 不应该报错', () => {
      expect(() => cache.delete('nonexistent')).not.toThrow();
    });
  });

  describe('clear', () => {
    test('应该清空所有缓存', () => {
      cache.set('key1', { data: 1 });
      cache.set('key2', { data: 2 });
      cache.set('key3', { data: 3 });

      cache.clear();

      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
      expect(cache.get('key3')).toBeNull();
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe('getStats', () => {
    test('应该返回正确的统计信息', () => {
      const stats = cache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.maxSize).toBe(5);
      expect(stats.defaultTTL).toBe(1000);
    });

    test('统计应该随缓存变化', () => {
      cache.set('key1', { data: 1 });
      cache.set('key2', { data: 2 });

      const stats = cache.getStats();
      expect(stats.size).toBe(2);
    });
  });

  describe('has', () => {
    test('应该正确检查 key 是否存在', () => {
      cache.set('key1', { data: 'value' });
      expect(cache.has('key1')).toBe(true);
      expect(cache.has('nonexistent')).toBe(false);
    });
  });
});
