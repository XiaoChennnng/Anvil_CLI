'use strict';

const {
  parseDuckDuckGoHTML,
  stripHtml,
} = require('../../../../src/core/web_search/duckduckgo');

describe('duckduckgo', () => {
  describe('stripHtml', () => {
    test('应该移除 HTML 标签', () => {
      expect(stripHtml('<b>bold</b>')).toBe('bold');
      expect(stripHtml('<p>paragraph</p>')).toBe('paragraph');
    });

    test('应该解码实体', () => {
      expect(stripHtml('Hello &amp; World')).toBe('Hello & World');
      expect(stripHtml('a&nbsp;b')).toBe('a b');
    });

    test('应该合并空白', () => {
      expect(stripHtml('  a  b  ')).toBe('a b');
    });
  });

  describe('parseDuckDuckGoHTML', () => {
    test('空输入返回空结果', () => {
      expect(parseDuckDuckGoHTML('', 8)).toEqual({ results: [], captcha: false });
      expect(parseDuckDuckGoHTML(null, 8)).toEqual({ results: [], captcha: false });
    });

    test('应该检测验证码', () => {
      const html = '<html><body>Please complete the security check</body></html>';
      const result = parseDuckDuckGoHTML(html, 8);
      expect(result.captcha).toBe(true);
      expect(result.results).toEqual([]);
    });

    test('应该解析标准结果结构', () => {
      const html = `
        <div class="result">
          <h2 class="result__title">
            <a href="https://example.com/article" class="result__a">Example Article Title</a>
          </h2>
          <a class="result__snippet">This is a snippet describing the article content.</a>
        </div>
        <div class="result">
          <h2 class="result__title">
            <a href="https://test.com/page" class="result__a">Test Page Title</a>
          </h2>
          <a class="result__snippet">Another snippet for testing.</a>
        </div>
      `;
      const result = parseDuckDuckGoHTML(html, 8);
      expect(result.captcha).toBe(false);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual({
        title: 'Example Article Title',
        url: 'https://example.com/article',
        snippet: 'This is a snippet describing the article content.',
        source: 'duckduckgo',
        position: 1,
      });
    });

    test('应该遵守 maxResults 限制', () => {
      const html = `
        <div class="result">
          <h2 class="result__title"><a href="https://1.com" class="result__a">Title 1</a></h2>
          <a class="result__snippet">Snippet 1</a>
        </div>
        <div class="result">
          <h2 class="result__title"><a href="https://2.com" class="result__a">Title 2</a></h2>
          <a class="result__snippet">Snippet 2</a>
        </div>
        <div class="result">
          <h2 class="result__title"><a href="https://3.com" class="result__a">Title 3</a></h2>
          <a class="result__snippet">Snippet 3</a>
        </div>
      `;
      const result = parseDuckDuckGoHTML(html, 2);
      expect(result.results).toHaveLength(2);
    });

    test('应该跳过 DuckDuckGo 内部链接', () => {
      const html = `
        <div class="result">
          <h2 class="result__title">
            <a href="https://duckduckgo.com/y.js" class="result__a">Internal Link</a>
          </h2>
          <a class="result__snippet">This should be skipped</a>
        </div>
        <div class="result">
          <h2 class="result__title">
            <a href="https://example.com/valid" class="result__a">Valid Link</a>
          </h2>
          <a class="result__snippet">This should be included</a>
        </div>
      `;
      const result = parseDuckDuckGoHTML(html, 8);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].url).toBe('https://example.com/valid');
    });

    test('应该处理无摘要的结果', () => {
      const html = `
        <div class="result">
          <h2 class="result__title">
            <a href="https://example.com" class="result__a">Title Only</a>
          </h2>
        </div>
      `;
      const result = parseDuckDuckGoHTML(html, 8);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].snippet).toBe('');
    });

    test('应该解码 DuckDuckGo 重定向链接', () => {
      const html = `
        <div class="result">
          <h2 class="result__title">
            <a href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.com" class="result__a">Title</a>
          </h2>
          <a class="result__snippet">Snippet</a>
        </div>
      `;
      const result = parseDuckDuckGoHTML(html, 8);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].url).toBe('https://example.com');
    });

    test('无结果时返回空数组', () => {
      const html = '<html><body><h1>Search Results</h1><p>No results found</p></body></html>';
      const result = parseDuckDuckGoHTML(html, 8);
      expect(result.results).toEqual([]);
      expect(result.captcha).toBe(false);
    });
  });
});
