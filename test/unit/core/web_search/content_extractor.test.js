'use strict';

const {
  extractContent,
  extractArticle,
  extractText,
  extractHtml,
  decodeHtmlEntities,
  calculateTextDensity,
} = require('../../../../src/core/web_search/content_extractor');

describe('content_extractor', () => {
  describe('decodeHtmlEntities', () => {
    test('应该解码基本实体', () => {
      expect(decodeHtmlEntities('&amp;')).toBe('&');
      expect(decodeHtmlEntities('&lt;')).toBe('<');
      expect(decodeHtmlEntities('&gt;')).toBe('>');
      expect(decodeHtmlEntities('&quot;')).toBe('"');
    });

    test('应该解码数字实体', () => {
      expect(decodeHtmlEntities('&#39;')).toBe("'");
      expect(decodeHtmlEntities('&#174;')).toBe('®');
    });

    test('应该解码十六进制实体', () => {
      expect(decodeHtmlEntities('&#x27;')).toBe("'");
      expect(decodeHtmlEntities('&#xAE;')).toBe('®');
    });

    test('应该处理混合内容', () => {
      const input = 'Hello &amp; World &lt;tag&gt;';
      expect(decodeHtmlEntities(input)).toBe('Hello & World <tag>');
    });
  });

  describe('calculateTextDensity', () => {
    test('纯文本应该有高密度', () => {
      const html = '<p>这是一段很长的中文文本内容，用来测试文本密度的计算。</p>';
      const density = calculateTextDensity(html);
      expect(density).toBeGreaterThan(0.5);
    });

    test('HTML 标签多的应该有低密度', () => {
      const html = '<div><span><b><i>短</i></b></span></div>';
      const density = calculateTextDensity(html);
      expect(density).toBeLessThan(0.5);
    });

    test('空字符串应该返回 0', () => {
      expect(calculateTextDensity('')).toBe(0);
    });
  });

  describe('extractText', () => {
    test('应该去除 script 标签', () => {
      const html = '<p>正文</p><script>alert("xss")</script>';
      const result = extractText(html);
      expect(result).toBe('正文');
      expect(result).not.toContain('script');
      expect(result).not.toContain('alert');
    });

    test('应该去除 style 标签', () => {
      const html = '<p>正文</p><style>body{color:red}</style>';
      const result = extractText(html);
      expect(result).toBe('正文');
    });

    test('应该解码 HTML 实体', () => {
      const html = '<p>Hello &amp; World</p>';
      const result = extractText(html);
      expect(result).toBe('Hello & World');
    });

    test('应该合并多余空白', () => {
      const html = '<p>  多   个   空格  </p>';
      const result = extractText(html);
      expect(result).toBe('多 个 空格');
    });
  });

  describe('extractHtml', () => {
    test('应该清理 script 标签', () => {
      const html = '<p>正文</p><script>alert(1)</script>';
      const result = extractHtml(html);
      expect(result).toContain('<p>正文</p>');
      expect(result).not.toContain('<script>');
    });

    test('应该清理 HTML 注释', () => {
      const html = '<p>正文</p><!-- 注释 -->';
      const result = extractHtml(html);
      expect(result).toContain('<p>正文</p>');
      expect(result).not.toContain('<!--');
    });

    test('应该保留安全的标签', () => {
      const html = '<h1>标题</h1><p>段落<strong>加粗</strong></p>';
      const result = extractHtml(html);
      expect(result).toContain('<h1>标题</h1>');
      expect(result).toContain('<p>段落<strong>加粗</strong></p>');
    });
  });

  describe('extractArticle', () => {
    test('应该识别 article 标签内容', () => {
      const html = `
        <nav>导航</nav>
        <article>
          <h1>文章标题</h1>
          <p>这是文章正文的第一段，需要有足够的长度来通过内容筛选。文章正文应该包含多个句子，描述详细的内容。</p>
          <p>这是第二段内容，同样需要有足够的长度。</p>
        </article>
        <footer>页脚</footer>
      `;
      const result = extractArticle(html);
      expect(result).toContain('文章标题');
      expect(result).toContain('这是文章正文');
      expect(result).not.toContain('导航');
      expect(result).not.toContain('页脚');
    });

    test('应该过滤掉太短的内容', () => {
      const html = '<div>短</div><div>这是一段很长的内容，需要有足够的字数才能被识别为有效内容，因为提取器会过滤掉太短的内容区块。</div>';
      const result = extractArticle(html);
      expect(result).not.toBe('短');
      expect(result.length).toBeGreaterThan(10);
    });
  });

  describe('extractContent', () => {
    test('应该支持 article 模式', () => {
      const html = '<article><p>这是一段很长的文章内容，需要有足够的字数才能被正确提取。</p></article>';
      const result = extractContent(html, 'article', 1000);
      expect(result.success).toBe(true);
      expect(result.extractType).toBe('article');
      expect(result.content).toContain('文章内容');
    });

    test('应该支持 text 模式', () => {
      const html = '<p>纯文本内容</p><script>脚本</script>';
      const result = extractContent(html, 'text');
      expect(result.success).toBe(true);
      expect(result.content).toBe('纯文本内容');
    });

    test('应该支持 html 模式', () => {
      const html = '<p>HTML内容</p>';
      const result = extractContent(html, 'html');
      expect(result.success).toBe(true);
      expect(result.content).toContain('<p>');
    });

    test('应该正确处理空输入', () => {
      const result = extractContent('');
      expect(result.error).toBeDefined();
    });

    test('应该正确处理 null', () => {
      const result = extractContent(null);
      expect(result.error).toBeDefined();
    });

    test('应该截断过长的内容', () => {
      const longText = 'a'.repeat(10000);
      const html = `<p>${longText}</p>`;
      const result = extractContent(html, 'text', 100);
      expect(result.content.length).toBeLessThanOrEqual(110); // 100 + "...(已截断)"
      expect(result.content).toContain('...(已截断)');
    });

    test('应该返回不支持的类型错误', () => {
      const result = extractContent('<p>test</p>', 'unsupported');
      expect(result.error).toContain('不支持的提取类型');
    });

    test('应该返回原始和提取后的长度', () => {
      const html = '<p>这是一段测试内容</p>';
      const result = extractContent(html, 'text');
      expect(result.originalLength).toBeDefined();
      expect(result.extractedLength).toBeDefined();
    });
  });
});
