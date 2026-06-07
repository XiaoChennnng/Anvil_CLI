'use strict';

const { normalizeToMarkdownList } = require('../../../src/tools/plan_mode');

describe('normalizeToMarkdownList', () => {
  describe('空值处理', () => {
    test('null 返回空字符串', () => {
      expect(normalizeToMarkdownList(null)).toBe('');
    });

    test('undefined 返回空字符串', () => {
      expect(normalizeToMarkdownList(undefined)).toBe('');
    });

    test('空字符串返回空字符串', () => {
      expect(normalizeToMarkdownList('')).toBe('');
    });
  });

  describe('数组输入', () => {
    test('字符串数组默认用 - 前缀', () => {
      const input = ['step 1', 'step 2', 'step 3'];
      const expected = '- step 1\n- step 2\n- step 3';
      expect(normalizeToMarkdownList(input)).toBe(expected);
    });

    test('字符串数组 ordered=true 用 1. 2. 3. 前缀', () => {
      const input = ['创建首页', '创建关于页', '创建博客页'];
      const expected = '1. 创建首页\n2. 创建关于页\n3. 创建博客页';
      expect(normalizeToMarkdownList(input, { ordered: true })).toBe(expected);
    });

    test('过滤空字符串元素', () => {
      const input = ['file1.js', '', '  ', 'file2.js'];
      const expected = '- file1.js\n- file2.js';
      expect(normalizeToMarkdownList(input)).toBe(expected);
    });

    test('数组元素含换行时缩进对齐', () => {
      const input = ['step 1\n  详情', 'step 2'];
      const result = normalizeToMarkdownList(input, { ordered: true });
      expect(result).toContain('1. step 1\n    详情');
      expect(result).toContain('2. step 2');
    });

    test('数组元素是对象时 JSON 化', () => {
      const input = [{ name: 'a.js' }, 'b.js'];
      const result = normalizeToMarkdownList(input);
      expect(result).toContain('{"name":"a.js"}');
      expect(result).toContain('b.js');
    });
  });

  describe('字符串输入 - 字面转义还原', () => {
    test('字面 \\n 还原为真换行', () => {
      const input = '1. 第一步\\n2. 第二步\\n3. 第三步';
      const expected = '1. 第一步\n2. 第二步\n3. 第三步';
      expect(normalizeToMarkdownList(input)).toBe(expected);
    });

    test('字面 \\r\\n 还原为单换行', () => {
      const input = 'line1\\r\\nline2';
      const expected = 'line1\nline2';
      expect(normalizeToMarkdownList(input)).toBe(expected);
    });

    test('字面 \\t 转两个空格', () => {
      const input = 'col1\\tcol2';
      const expected = 'col1  col2';
      expect(normalizeToMarkdownList(input)).toBe(expected);
    });

    test('真实 \\r\\n 归一化为 \\n', () => {
      const input = 'line1\r\nline2\r\nline3';
      const expected = 'line1\nline2\nline3';
      expect(normalizeToMarkdownList(input)).toBe(expected);
    });
  });

  describe('字符串输入 - 正常 Markdown', () => {
    test('多行 Markdown 列表保持原样', () => {
      const input = '1. 第一步\n2. 第二步\n3. 第三步';
      expect(normalizeToMarkdownList(input)).toBe(input);
    });

    test('带 - 列表项的字符串保持原样', () => {
      const input = '- file1.js\n- file2.js';
      expect(normalizeToMarkdownList(input)).toBe(input);
    });

    test('去除首尾空白', () => {
      const input = '  \n  内容  \n  ';
      expect(normalizeToMarkdownList(input)).toBe('内容');
    });
  });

  describe('对象输入', () => {
    test('对象转为 key: value 列表', () => {
      const input = { name: 'anvil', version: '0.1.0' };
      const result = normalizeToMarkdownList(input);
      expect(result).toContain('- **name**: anvil');
      expect(result).toContain('- **version**: 0.1.0');
    });

    test('嵌套对象的值 JSON 化', () => {
      const input = { config: { proxy: 'http://x' } };
      const result = normalizeToMarkdownList(input);
      expect(result).toContain('- **config**: {"proxy":"http://x"}');
    });
  });

  describe('数字/布尔值', () => {
    test('数字转字符串', () => {
      expect(normalizeToMarkdownList(42)).toBe('42');
    });

    test('布尔转字符串', () => {
      expect(normalizeToMarkdownList(true)).toBe('true');
    });
  });

  describe('回归：LLM 常见坑场景', () => {
    test('LLM 传数组当 files：避免逗号连接', () => {
      const files = ['src/cli/index.js', 'src/tools/plan_mode.js', 'src/ui/markdown.js'];
      const result = normalizeToMarkdownList(files);
      expect(result).not.toContain(',');
      expect(result.split('\n')).toHaveLength(3);
    });

    test('LLM 传字面 \\n 字符串当 steps：还原为真换行', () => {
      const steps = '1. index.html — 创建首页\\n2. about.html — 创建关于我页面\\n3. blog/index.html — 创建博客列表';
      const result = normalizeToMarkdownList(steps);
      expect(result).not.toContain('\\n');
      expect(result.split('\n')).toHaveLength(3);
    });

    test('LLM 传单个长字符串当 files（按 description 不推荐但容错）', () => {
      const files = 'a.js, b.js, c.js';
      const result = normalizeToMarkdownList(files);
      expect(result).toBe('a.js, b.js, c.js');
    });
  });

  describe('回归：tool-renderer 调用安全（不能直接 .match / .split 数组）', () => {
    test('数组 steps 经过 normalize 后能 .match() 算出 step 数', () => {
      // 模拟 src/ui/tool-renderer.js:244-250 的调用模式
      const args = { steps: ['创建首页', '创建关于页', '创建博客页'] };
      const stepsStr = normalizeToMarkdownList(args.steps, { ordered: true });
      expect(typeof stepsStr).toBe('string');
      const stepCount = (stepsStr.match(/^\d+[.、]/gm) || []).length || 1;
      expect(stepCount).toBe(3);
    });

    test('数组 files 经过 normalize 后能 .split(\'\\n\') 算出文件数', () => {
      const args = { files: ['index.html', 'about.html', 'blog/index.html'] };
      const filesStr = normalizeToMarkdownList(args.files, { ordered: false });
      expect(typeof filesStr).toBe('string');
      const fileCount = filesStr.split('\n').filter(l => l.trim()).length;
      expect(fileCount).toBe(3);
    });

    test('对象 steps 经过 normalize 后能 .match() 不抛 TypeError', () => {
      const args = { steps: { a: 'step1', b: 'step2' } };
      const stepsStr = normalizeToMarkdownList(args.steps, { ordered: true });
      expect(typeof stepsStr).toBe('string');
      // 对象被转成 `- **a**: step1` 格式，不会被 `^\d+[.、]` 匹配，但也不会炸
      const stepCount = (stepsStr.match(/^\d+[.、]/gm) || []).length || 1;
      expect(stepCount).toBeGreaterThanOrEqual(1);
    });

    test('数字 steps 经过 normalize 后是字符串', () => {
      const args = { steps: 42 };
      const stepsStr = normalizeToMarkdownList(args.steps, { ordered: true });
      expect(typeof stepsStr).toBe('string');
    });
  });
});
