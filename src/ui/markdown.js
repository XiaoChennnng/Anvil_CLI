'use strict';

const chalk = require('chalk');
const { highlight } = require('cli-highlight');
const { marked } = require('marked');
const { markedTerminal } = require('marked-terminal');
const { getTheme } = require('./theme');

class MarkdownRenderer {
  constructor(width) {
    this.theme = getTheme();
    this.width = width || process.stdout.columns || 80;
    this.lineBuffer = '';  // 累积不完整的行
    this._inCodeBlock = false;  // 是否在代码块内
    this._lastRenderedLine = null;  // 只跳过连续重复行，不全局去重
    this._tableBuffer = [];  // 表格行缓冲（表格需要多行一起渲染成框线表）
    this._inTable = false;   // 是否在表格内
    this._codeBlockBuffer = [];  // 代码块内容缓冲
    this._codeBlockLanguage = '';  // 代码块语言标识
    // 预构建语法高亮主题，避免每次代码块重建 24 个闭包
    this._syntaxTheme = this._buildSyntaxTheme();
    this._setupRenderer();
  }

  /**
   * 构建 cli-highlight 语法高亮主题
   * 映射 Anvil theme 的 syntax* 颜色到 cli-highlight Theme 格式
   */
  _buildSyntaxTheme() {
    const t = this.theme;
    return {
      keyword: (s) => chalk.hex(t.colors.syntaxKeyword)(s),
      built_in: (s) => chalk.hex(t.colors.syntaxType)(s),
      type: (s) => chalk.hex(t.colors.syntaxType)(s),
      literal: (s) => chalk.hex(t.colors.syntaxKeyword)(s),
      number: (s) => chalk.hex(t.colors.syntaxNumber)(s),
      regexp: (s) => chalk.hex(t.colors.syntaxString)(s),
      string: (s) => chalk.hex(t.colors.syntaxString)(s),
      subst: (s) => chalk.hex(t.colors.syntaxString)(s),
      symbol: (s) => chalk.hex(t.colors.syntaxFunction)(s),
      class: (s) => chalk.hex(t.colors.syntaxType)(s),
      function: (s) => chalk.hex(t.colors.syntaxFunction)(s),
      title: (s) => chalk.hex(t.colors.syntaxFunction)(s),
      params: (s) => chalk.hex(t.colors.text)(s),
      comment: (s) => chalk.hex(t.colors.syntaxComment)(s),
      doctag: (s) => chalk.hex(t.colors.syntaxComment).italic(s),
      meta: (s) => chalk.hex(t.colors.syntaxOperator)(s),
      'meta-keyword': (s) => chalk.hex(t.colors.syntaxKeyword)(s),
      'meta-string': (s) => chalk.hex(t.colors.syntaxString)(s),
      section: (s) => chalk.hex(t.colors.syntaxFunction).bold(s),
      tag: (s) => chalk.hex(t.colors.syntaxVariable)(s),
      name: (s) => chalk.hex(t.colors.syntaxVariable)(s),
      'builtin-name': (s) => chalk.hex(t.colors.syntaxType)(s),
      attr: (s) => chalk.hex(t.colors.syntaxFunction)(s),
      attribute: (s) => chalk.hex(t.colors.syntaxFunction)(s),
      variable: (s) => chalk.hex(t.colors.syntaxVariable)(s),
      bullet: (s) => chalk.hex(t.colors.syntaxPunctuation)(s),
      code: (s) => chalk.hex(t.colors.markdownCode)(s),
      emphasis: (s) => chalk.hex(t.colors.text).italic(s),
      strong: (s) => chalk.hex(t.colors.text).bold(s),
      formula: (s) => chalk.hex(t.colors.syntaxOperator)(s),
      link: (s) => chalk.hex(t.colors.syntaxOperator).underline(s),
      quote: (s) => chalk.hex(t.colors.syntaxComment).italic(s),
      addition: (s) => chalk.hex(t.colors.diffAdded)(s),
      deletion: (s) => chalk.hex(t.colors.diffRemoved)(s),
      default: (s) => chalk.hex(t.colors.text)(s),
    };
  }

  /**
   * 配置 marked-terminal 渲染器
   * 1:1 复刻 opencode glamour 样式
   */
  _setupRenderer() {
    const t = this.theme;
    const syntaxTheme = this._syntaxTheme;

    // 配置 marked 使用 markedTerminal
    // 第二个参数 highlightOptions 传递给内置的 cli-highlight
    marked.use(markedTerminal({
      // 标题样式: bold + Secondary 色 (#5c9cf5)
      heading: chalk.hex(t.colors.markdownHeading).bold,

      // 一级标题特殊样式
      firstHeading: chalk.hex(t.colors.markdownHeading).bold.underline,

      // 代码块样式: 高亮失败时的回退色
      code: chalk.hex(t.colors.markdownCode),

      // 代码块选项
      codespan: chalk.hex(t.colors.markdownCode),

      // 引用块样式: Yellow 色 + italic (#e5c07b)
      blockquote: chalk.hex(t.colors.markdownBlockQuote).italic,

      // 粗体样式: Accent 色 + bold (#9d7cd8)
      strong: chalk.hex(t.colors.markdownStrong).bold,

      // 斜体样式: Yellow 色 + italic (#e5c07b)
      em: chalk.hex(t.colors.markdownEmph).italic,

      // 链接样式: Primary 色 + underline (#fab283)
      link: chalk.hex(t.colors.markdownLink).underline,

      // 链接地址样式: Primary 色 + underline (#fab283)
      href: chalk.hex(t.colors.markdownLink).underline,

      // 列表项样式: Primary 色 (#fab283)
      listitem: chalk.hex(t.colors.markdownListItem),

      // 水平线样式: 不渲染满屏横线，只输出一个空行分隔（免得满屏 --- 煞笔）
      hr: () => '',

      // 行内代码样式: Success 色 (#7fd88f)
      codespan: chalk.hex(t.colors.markdownCode),

      // 删除线样式: TextMuted 色 + strikethrough (#6a6a6a)
      del: chalk.hex(t.colors.textMuted).strikethrough,

      // 表格样式（自定义渲染器：将 marked-terminal 硬编码的灰色/红色替换为主题色）
      table: (tableText) => {
        // 简单的 hex → raw ANSI 前景色生成
        const hexToFgAnsi = (hex) => {
          const r = parseInt(hex.slice(1, 3), 16);
          const g = parseInt(hex.slice(3, 5), 16);
          const b = parseInt(hex.slice(5, 7), 16);
          return `\x1b[38;2;${r};${g};${b}m`;
        };
        // 替换硬编码的 chalk.gray(\x1b[90m) → 白色粗体边框
        // 替换硬编码的 chalk.red(\x1b[31m) → 主题 markdownHeading 色 + 粗体
        return tableText
          .replace(/\x1b\[90m/g, '\x1b[1m' + hexToFgAnsi(t.colors.text))
          .replace(/\x1b\[31m/g, '\x1b[1m' + hexToFgAnsi(t.colors.markdownHeading));
      },

      // 段落样式

      // HTML样式
      html: chalk.gray,

      // 配置选项
      width: this.width,
      reflowText: true,
      showSectionPrefix: true,
      unescape: true,
      emoji: true,
      tab: 2,

      // 表格选项
      tableOptions: {
        'padding-left': 1,
        'padding-right': 1,
        'border-color': t.colors.borderNormal,
      },
    }, {
      // cli-highlight 选项：自定义语法高亮主题
      theme: syntaxTheme,
      ignoreIllegals: true,
    }));
  }

  /**
   * 写入 chunk 并渲染（成块行处理）
   * 用 split 替代逐字符遍历，大幅减少字符串操作
   * @param {string} chunk
   * @returns {string}
   */
  write(chunk) {
    if (!chunk) {return '';}
    let output = '';

    // 合并到 lineBuffer 后再拆分处理
    this.lineBuffer += chunk;

    // 如果没有换行符，全部留在 lineBuffer 中
    const newlineIdx = this.lineBuffer.indexOf('\n');
    if (newlineIdx === -1) {return '';}

    // 按换行拆分，最后一段是可能不完整的行
    const lines = this.lineBuffer.split('\n');
    // 最后一段没有换行符的留在 lineBuffer
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      // 处理每一行（不含换行符）
      if (!line.trim()) {
        // 空行 → 如果正在表格中，触发表格刷新
        if (this._inTable) {
          const tableOutput = this._flushTable();
          if (tableOutput) {output += tableOutput + '\n';}
        }
        // 空行 → 如果正在代码块中，累积到代码块缓冲
        if (this._inCodeBlock) {
          this._codeBlockBuffer.push('');
        }
        continue;
      }

      const trimmed = line.trim();

      // 检测代码块开始: ``` 后面跟语言标识
      if (/^```/.test(trimmed) && trimmed !== '```') {
        // 代码块结束之前，先flush之前累积的代码块内容（如果有）
        if (this._inCodeBlock && this._codeBlockBuffer.length > 0) {
          const codeOutput = this._highlightCodeBlock();
          output += codeOutput;
          this._codeBlockBuffer = [];
        }
        // 开始新的代码块
        this._inCodeBlock = true;
        this._codeBlockLanguage = trimmed.slice(3).trim() || 'plaintext';
        this._codeBlockBuffer = [];
        continue;
      }

      // 检测代码块结束: 只有单独的 ```
      if (this._inCodeBlock && trimmed === '```') {
        // 用 cli-highlight 处理累积的代码块内容
        const codeOutput = this._highlightCodeBlock();
        output += codeOutput;
        this._codeBlockBuffer = [];
        this._inCodeBlock = false;
        this._codeBlockLanguage = '';
        continue;
      }

      // 如果在代码块内，累积内容到缓冲
      if (this._inCodeBlock) {
        this._codeBlockBuffer.push(line);
        continue;
      }

      // 检测表格行：trim 后以 | 开头且包含至少一个 |
      const isTableRow = trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1;

      if (isTableRow) {
        this._tableBuffer.push(line);
        this._inTable = true;
        continue;
      }

      // 如果在表格中，当前行不是表格行 → 表格结束，刷新缓冲
      if (this._inTable) {
        const tableOutput = this._flushTable();
        if (tableOutput) {output += tableOutput + '\n';}
      }

      const rendered = this._renderLine(line, this._inCodeBlock);
      if (rendered) {
        output += rendered + '\n';
      }
    }

    // 移除末尾的换行符（方便直接输出）
    if (output.endsWith('\n')) {
      output = output.slice(0, -1);
    }

    return output;
  }

  /**
   * 使用 cli-highlight 高亮代码块
   */
  _highlightCodeBlock() {
    if (this._codeBlockBuffer.length === 0) {
      return '';
    }
    const code = this._codeBlockBuffer.join('\n');
    try {
      const highlighted = highlight(code, {
        language: this._codeBlockLanguage || 'plaintext',
        theme: this._syntaxTheme,
        ignoreIllegals: true,
      });
      // 分割高亮后的内容，逐行输出
      const lines = highlighted.split('\n');
      let result = '';
      for (const line of lines) {
        if (line.trim()) {
          result += line + '\n';
        }
      }
      return result;
    } catch {
      // 高亮失败，回退到灰色输出
      let result = '';
      for (const line of this._codeBlockBuffer) {
        if (line.trim()) {
          result += chalk.hex(this.theme.colors.textMuted)(line) + '\n';
        }
      }
      return result;
    }
  }

  /**
   * 快速检测行是否包含 markdown 语法
   * 纯文本行直接跳过 marked.parse()，节省约 100x 开销
   * 保守检测，宁可误判也不要漏掉 markdown 语法
   * @param {string} line
   * @returns {boolean}
   */
  _hasMarkdownSyntax(line) {
    const len = line.length;
    if (len === 0) {return false;}

    let i = 0;
    // 跳过行首空白
    while (i < len && line[i] === ' ') {i++;}

    if (i >= len) {return false;}

    const first = line[i];

    // 标题 # 或引用 >
    if (first === '#' || first === '>') {return true;}

    // 列表标记：- * + 后跟空格，或数字. 数字)
    if (first === '-' || first === '*' || first === '+') {
      if (i + 1 < len && line[i + 1] === ' ') {return true;}
    }
    if (first >= '0' && first <= '9') {
      let j = i;
      while (j < len && line[j] >= '0' && line[j] <= '9') {j++;}
      if (j < len && (line[j] === '.' || line[j] === ')')) {return true;}
    }

    // 表格行
    if (first === '|') {
      if (line.indexOf('|', i + 1) !== -1) {return true;}
    }

    // 代码围栏（连续三个以上反引号或波浪号）
    if (first === '`' || first === '~') {
      let count = 0;
      while (i + count < len && line[i + count] === first) {count++;}
      if (count >= 3) {return true;}
    }

    // 水平线（三个以上 - * _）
    if (first === '-' || first === '*' || first === '_') {
      let count = 0;
      while (i + count < len && (line[i + count] === '-' || line[i + count] === '*' || line[i + count] === '_')) {
        count++;
      }
      // 如果行里还有空格分隔，也算水平线
      if (count >= 3) {
        const rest = line.slice(i + count).trim();
        if (rest === '' || /^[\s\-*_]+$/.test(rest)) {return true;}
      }
    }

    // 行内语法检测（非行首位置）
    // 反引号 `` 行内代码
    if (line.indexOf('`') !== -1) {return true;}
    // 链接 [ ]( ) 或图片 ![
    if (line.indexOf('[') !== -1 || line.indexOf('!') !== -1) {return true;}
    // 粗体 ** 或 __
    if (line.indexOf('**') !== -1 || line.indexOf('__') !== -1) {return true;}
    // 删除线 ~~
    if (line.indexOf('~~') !== -1) {return true;}

    return false;
  }

  /**
   * 渲染单行 markdown
   * @param {string} line
   * @param {boolean} inCodeBlock - 是否在代码块内
   * @returns {string|null}
   */
  _renderLine(line, inCodeBlock = false) {
    // 跳过空行
    if (!line || !line.trim()) {
      return null;
    }

    // 去重：只跳过连续重复行（流式重发时同一行被多次推送）
    // 不跳过非连续的重复行（如表格分隔线、重复标题等）
    if (line === this._lastRenderedLine) {
      return null;
    }
    this._lastRenderedLine = line;

    // 如果在代码块内，使用灰色输出（更接近终端编辑器风格）
    if (inCodeBlock) {
      return chalk.hex(this.theme.colors.textMuted)(line);
    }

    // 纯文本行快速 bypass：跳过 marked.parse()（约 100x 快）
    if (!this._hasMarkdownSyntax(line)) {
      return chalk.hex(this.theme.colors.text)(line);
    }

    // 检测是否是代码块标记行
    const isCodeBlockStart = /^```/.test(line.trim());
    const isCodeBlockEnd = line.trim() === '```';

    try {
      // 使用 marked 渲染单行
      const rendered = marked.parse(line);

      // 移除末尾换行符（marked会添加）
      const result = rendered.replace(/\n$/, '');

      // 如果渲染结果为空或只有空白，返回 null
      if (!result.trim()) {
        return null;
      }

      // 如果结果只是给原文加了颜色（marked 的处理），且原行是代码块标记，直接返回原文
      // 这样可以避免 marked 对代码块标记的特殊处理导致重复
      if (isCodeBlockStart || isCodeBlockEnd) {
        // 代码块标记直接用灰色输出
        return chalk.dim(line);
      }

      return result;
    } catch {
      // 解析失败，返回原文
      return line;
    }
  }

  /**
   * 刷新表格缓冲：将累积的表格行一次性渲染
   * 表格需要表头 + 分隔线 + 数据行一起才能渲染成框线表
   * @returns {string}
   */
  _flushTable() {
    if (this._tableBuffer.length === 0) {return '';}
    this._inTable = false;
    const tableSource = this._tableBuffer.join('\n');
    this._tableBuffer = [];

    try {
      const rendered = marked.parse(tableSource);
      return rendered.replace(/\n$/, '');
    } catch {
      return tableSource;
    }
  }

  /**
   * 刷新缓冲区（处理剩余内容）
   */
  flush() {
    let output = '';

    // 先刷新未完成的表格缓冲
    if (this._inTable) {
      const tableOutput = this._flushTable();
      if (tableOutput) {output += tableOutput + '\n';}
    }

    if (this.lineBuffer && this.lineBuffer.trim()) {
      const rendered = this._renderLine(this.lineBuffer, this._inCodeBlock);
      this.lineBuffer = '';
      if (rendered) {output += rendered;}
    } else {
      this.lineBuffer = '';
    }

    // 移除末尾换行
    if (output.endsWith('\n')) {output = output.slice(0, -1);}
    return output;
  }

  /**
   * 渲染完整的 markdown 内容
   * @param {string} content
   * @returns {string}
   */
  render(content) {
    try {
      return marked.parse(content);
    } catch {
      return content;
    }
  }

  /**
   * 重置状态
   */
  reset() {
    this.lineBuffer = '';
    this._inCodeBlock = false;
    this._lastRenderedLine = null;
    this._tableBuffer = [];
    this._inTable = false;
  }

  /**
   * 检查是否在代码块中
   */
  get isInCodeBlock() {
    return false;
  }
}

module.exports = MarkdownRenderer;