'use strict';

const chalk = require('chalk');
const { highlight } = require('cli-highlight');
const { marked } = require('marked');
const { markedTerminal } = require('marked-terminal');
const Table = require('cli-table3');
const { getTheme } = require('./theme');
const { visibleLength } = require('./ansi');

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
    this._syntaxTheme = this._buildSyntaxTheme();
    this._setupRenderer();
  }

  // 构建 cli-highlight 语法高亮主题
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

  // 配置 marked-terminal 渲染器
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

      // 水平线样式: 不渲染满屏横线，只输出空行分隔
      hr: () => '',

      // 行内代码样式: Success 色 (#7fd88f)
      codespan: chalk.hex(t.colors.markdownCode),

      // 删除线样式: TextMuted 色 + strikethrough (#6a6a6a)
      del: chalk.hex(t.colors.textMuted).strikethrough,

      // 表格样式：将 marked-terminal 硬编码的灰色/红色替换为主题色
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

  // 写入 chunk 并渲染（成块行处理）
  write(chunk) {
    if (!chunk) {return '';}
    let output = '';

    // 合并到 lineBuffer 后再拆分处理
    this.lineBuffer += chunk;

    // 如果没有换行符，检查是否需要超时刷新
    const newlineIdx = this.lineBuffer.indexOf('\n');
    if (newlineIdx === -1) {
      // buffer 超过 200 字符但没有换行符时，强制刷新避免内容延迟
      if (this.lineBuffer.length > 200) {
        const output = this._renderLine(this.lineBuffer, this._inCodeBlock);
        this.lineBuffer = '';
        return output;
      }
      return '';
    }

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

  // 使用 cli-highlight 高亮代码块
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

  // 快速检测行是否包含 markdown 语法，纯文本行跳过 marked.parse()
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
    // 斜体 * 或 _（非列表标记、非加粗的单个标记）
    if (line.indexOf('*') !== -1 && line.indexOf('**') === -1) {return true;}
    if (line.indexOf('_') !== -1 && line.indexOf('__') === -1) {return true;}
    // Emoji 短代码 :word:
    if (/:[a-zA-Z_+-]+:/.test(line)) {return true;}
    // URL autolink ://
    if (line.indexOf('://') !== -1) {return true;}

    return false;
  }

  // 渲染单行 markdown
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

  // 刷新表格缓冲：将累积的表格行一次性渲染
  _flushTable() {
    if (this._tableBuffer.length === 0) {return '';}
    this._inTable = false;
    const tableSource = this._tableBuffer.join('\n');
    this._tableBuffer = [];

    // 半残表格(无分隔行 |---|---|)不构成完整 GFM 表格,marked.parse 会原样返回
    // 不渲染框线,用户看到的是"无框线的半个表格"。这里用 dim 灰色直接显示原行,
    // 让用户清楚这是未渲染的 markdown 源码(AI 输出格式异常)而非渲染失败。
    if (!this._hasTableSeparator(tableSource)) {
      const lines = tableSource.split('\n');
      const rendered = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1) {
          rendered.push(chalk.hex(this.theme.colors.textMuted).dim(line));
        } else {
          const r = this._renderLine(line, false);
          if (r) {rendered.push(r);}
        }
      }
      return rendered.join('\n');
    }

    // marked-terminal 不按 width 压缩表格列宽,超宽时终端硬截断带 ANSI 转义符的行
    // 会导致框线和文字错位。这里预估自然宽度,超限就接管 cli-table3 自己渲染压缩表格
    // (保留框线视觉,列内文字按 visibleLength 预换行)。极窄放不下最小列宽时才退回 bullet list。
    const naturalWidth = this._estimateTableWidth(tableSource);
    if (naturalWidth > 0 && naturalWidth > this.width) {
      try {
        return this._renderCompressedTable(tableSource);
      } catch {
        // 异常兜底:走 list 路径,保证用户至少看到结构化内容而不是错位框线
        return this._tableToListFallback(tableSource);
      }
    }

    try {
      const rendered = marked.parse(tableSource);
      return rendered.replace(/\n$/, '');
    } catch {
      return tableSource;
    }
  }

  // 检测表格源是否包含 GFM 分隔行(形如 |---|---| 或 |:---:|---:|)
  _hasTableSeparator(source) {
    const lines = source.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // GFM 分隔行:每格必须是 - 或 : 组合,允许首尾 | 缺省
      if (/^\|?[\s\-:|]+\|?$/.test(trimmed) && /-/.test(trimmed)) {return true;}
    }
    return false;
  }

  // 解析 markdown 表格,估算每列自然宽度,返回表格总宽(含 padding 和边框)
  _estimateTableWidth(source) {
    const lines = source.split('\n').filter((l) => l.trim().startsWith('|'));
    if (lines.length < 2) {return 0;}
    const parseRow = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) {return null;}
      // 允许缺左 | 或缺右 | 的宽松解析
      const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
      return inner.split('|').map((c) => c.trim());
    };
    const isSeparator = (row) => row && row.every((c) => /^[\-:\s]+$/.test(c));
    const rows = lines.map(parseRow).filter(Boolean).filter((r) => !isSeparator(r));
    if (rows.length === 0) {return 0;}
    const colCount = Math.max(...rows.map((r) => r.length));
    const colWidths = new Array(colCount).fill(0);
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        const w = visibleLength(row[i] || '');
        if (w > colWidths[i]) {colWidths[i] = w;}
      }
    }
    // cli-table3: 总宽 = 列宽之和 + (列数+1) 个边框字符 + 列数*2 padding + 内部开销 buffer
    // 实际渲染会因字符宽度舍入、列最小宽度等有几字符偏差,加 8 字符 buffer 兜底
    const total = colWidths.reduce((a, b) => a + b, 0) + (colCount + 1) + colCount * 2 + 8;
    return total;
  }

  // 把 markdown 表格转成 bullet list markdown,避免窄终端下框线错位
  _tableToList(source) {
    const lines = source.split('\n').filter((l) => l.trim());
    const parseRow = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) {return null;}
      const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
      return inner.split('|').map((c) => c.trim());
    };
    const isSeparator = (row) => row && row.every((c) => /^[\-:\s]+$/.test(c));
    const rows = lines.map(parseRow).filter(Boolean).filter((r) => !isSeparator(r));
    if (rows.length === 0) {return '';}
    const headers = rows[0];
    const dataRows = rows.slice(1);
    const labelFor = (i) => headers[i] && headers[i].trim() ? headers[i].trim() : `列${i + 1}`;
    if (dataRows.length === 0) {
      // 只有表头时按"key: value"列表展示
      return headers
        .filter((h, i) => !(h && h.trim() === ''))
        .map((h) => `- **${h.trim() || `列${headers.indexOf(h) + 1}`}**`)
        .join('\n');
    }
    const blocks = [];
    for (const row of dataRows) {
      const items = [];
      for (let i = 0; i < headers.length; i++) {
        const value = (row[i] || '').trim();
        if (!value) {continue;}
        items.push(`  - **${labelFor(i)}**: ${value}`);
      }
      if (items.length > 0) {blocks.push(items.join('\n'));}
    }
    return blocks.join('\n\n');
  }

  // bullet list 渲染入口:对 _tableToList 的 markdown 走 marked.parse,统一极窄 + 异常兜底
  _tableToListFallback(source) {
    const listMarkdown = this._tableToList(source);
    if (!listMarkdown) {return '';}
    try {
      return marked.parse(listMarkdown).replace(/\n$/, '');
    } catch {
      return listMarkdown;
    }
  }

  // 压缩渲染超宽表格:保留框线视觉,列内文字按 visibleLength 预换行
  // 极窄放不下最小列宽时退回 _tableToListFallback
  _renderCompressedTable(source) {
    const lines = source.split('\n').filter((l) => l.trim());
    const parseRow = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) {return null;}
      const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
      return inner.split('|').map((c) => c.trim());
    };
    const isSeparator = (row) => row && row.every((c) => /^[\-:\s]+$/.test(c));
    const rows = lines.map(parseRow).filter(Boolean).filter((r) => !isSeparator(r));
    if (rows.length === 0) {return '';}
    const headers = rows[0];
    const dataRows = rows.slice(1);
    const colCount = Math.max(headers.length, ...dataRows.map((r) => r.length));

    // 1. 每列自然宽度(visibleLength,含 ANSI 剥离 + CJK 双倍宽)
    const naturalWidths = new Array(colCount).fill(0);
    for (const row of [headers, ...dataRows]) {
      for (let i = 0; i < colCount; i++) {
        const w = visibleLength(row[i] || '');
        if (w > naturalWidths[i]) {naturalWidths[i] = w;}
      }
    }

    // 2. 边框 + padding 开销;极窄兜底:连最小列宽都放不下就退回 list
    // MIN_COL_WIDTH=8 保证每列至少能放 4 个 CJK 汉字(colWidth 减 4 = 4 字符可见宽)
    const MIN_COL_WIDTH = 8;
    const borderOverhead = colCount + 1 + colCount * 2;
    if (this.width < colCount * MIN_COL_WIDTH + borderOverhead) {
      return this._tableToListFallback(source);
    }

    // 3. 按自然宽度比例压缩到 usableWidth,保证每列至少 MIN_COL_WIDTH
    const usableWidth = Math.max(this.width - borderOverhead, colCount * MIN_COL_WIDTH);
    const totalNatural = naturalWidths.reduce((a, b) => a + b, 0) || 1;
    const targetWidths = new Array(colCount).fill(0);
    let remaining = usableWidth;
    for (let i = 0; i < colCount; i++) {
      const raw = Math.floor(usableWidth * naturalWidths[i] / totalNatural);
      const target = Math.max(MIN_COL_WIDTH, Math.min(raw, remaining - (colCount - 1 - i) * MIN_COL_WIDTH));
      targetWidths[i] = target;
      remaining -= target;
    }
    // 取整差补给最宽列
    if (remaining > 0) {
      let widestIdx = 0;
      for (let i = 1; i < colCount; i++) {
        if (naturalWidths[i] > naturalWidths[widestIdx]) {widestIdx = i;}
      }
      targetWidths[widestIdx] += remaining;
    }

    // 4. 预换行:marked.parseInline 拿带 ANSI 字符串,再按 visibleLength 切多行
    // cli-table3 的 cell 不接受数组(虽然不报错但显示为空),必须传 \n 分隔的字符串
    // cli-table3 实际 cell 可用宽 = colWidth - 4(padding 2 + 内部 overhead 2)
    const CELL_OVERHEAD = 4;
    const wrapCell = (rawText, width) => {
      if (width <= 0) {return '';}
      const ansiText = marked.parseInline(rawText || '');
      const inner = Math.max(1, width - CELL_OVERHEAD);
      return this._wrapByVisibleLength(ansiText, inner).join('\n');
    };

    // 5. 构造 cli-table3,关闭它自己的 wordWrap(我们已预换行)
    const table = new Table({
      head: headers.map((h, i) => wrapCell(h, targetWidths[i])),
      colWidths: targetWidths,
      wordWrap: false,
      wrapOnWordBoundary: false,
      truncate: '…',
      style: { 'padding-left': 1, 'padding-right': 1, head: [], border: [] },
    });
    for (const row of dataRows) {
      const padded = new Array(colCount);
      for (let i = 0; i < colCount; i++) {padded[i] = wrapCell(row[i] || '', targetWidths[i]);}
      table.push(padded);
    }

    // 6. 主题替换(与 markedTerminal 的 o.table 回调一致的两段替换)
    return this._applyTableTheme(table.toString());
  }

  // 把带 ANSI 的字符串按 visibleLength 切成多行,切行时延续色码避免半截着色
  // 处理 CJK 双倍宽 + emoji surrogate pair 不拆开
  _wrapByVisibleLength(ansiText, maxWidth) {
    if (!ansiText || maxWidth <= 0) {return [ansiText || ''];}
    // 先按显式 \n 切(用户手动换行优先),再对每段按可见宽度切
    const segments = ansiText.split('\n');
    const out = [];
    // 当前累计的"激活色码",切行时在新行首重发,避免半截着色
    let activeCodes = '';

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      if (!segment) {
        out.push('');
        continue;
      }

      let line = '';
      let lineWidth = 0;
      let i = 0;
      while (i < segment.length) {
        // 1. 完整 ANSI 转义序列:不占显示宽度,记录到 activeCodes
        if (segment[i] === '\x1b') {
          const m = segment.slice(i).match(/^\x1b\[[0-9;]*[mHKhlA-Za-z=]|\x1b\?[0-9;]*[hl]|\x1b\][^\x07]*\x07|\x1b\\|\x1b\[\?1049[hl]|\x1b\[38;2;\d+;\d+;\d+m|\x1b\[48;2;\d+;\d+;\d+m/);
          if (m) {
            const code = m[0];
            if (code.endsWith('m')) {activeCodes += code;}
            line += code;
            i += code.length;
            continue;
          }
        }

        // 2. 计算当前字符的显示宽度
        let charLen = 1;
        let charStr = segment[i];
        // surrogate pair:高代理 + 低代理 视为单字符,宽度按可见长度(多数 emoji=2)
        if (i + 1 < segment.length && charStr.charCodeAt(0) >= 0xD800 && charStr.charCodeAt(0) <= 0xDBFF) {
          charStr = segment.slice(i, i + 2);
          charLen = 2;
        }
        const visible = visibleLength(charStr);

        // 3. 当前字符放得下就累积
        if (lineWidth + visible <= maxWidth) {
          line += charStr;
          lineWidth += visible;
          i += charLen;
          continue;
        }

        // 4. 放不下就切行:新行首补 activeCodes 延续色码
        out.push(line);
        line = activeCodes;
        lineWidth = 0;

        // 5. 边界保护:单字符宽度 > maxWidth,强制放入新行(交给 cli-table3 truncate 兜底)
        if (visible > maxWidth) {
          line += charStr;
          i += charLen;
          // 下一行再继续
          continue;
        }
      }

      if (line.length > 0 || segIdx < segments.length - 1) {
        out.push(line);
      }
    }

    return out.length > 0 ? out : [''];
  }

  // 复用 markedTerminal o.table 回调的主题替换:灰边框→文本色,红表头→标题色
  _applyTableTheme(rawText) {
    const t = this.theme;
    const hexToFgAnsi = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `\x1b[38;2;${r};${g};${b}m`;
    };
    return rawText
      .replace(/\x1b\[90m/g, '\x1b[1m' + hexToFgAnsi(t.colors.text))
      .replace(/\x1b\[31m/g, '\x1b[1m' + hexToFgAnsi(t.colors.markdownHeading));
  }

  // 刷新缓冲区（处理剩余内容）
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

  // 渲染完整的 markdown 内容
  render(content) {
    try {
      return marked.parse(content);
    } catch {
      return content;
    }
  }

  // 重置状态
  reset() {
    this.lineBuffer = '';
    this._inCodeBlock = false;
    this._lastRenderedLine = null;
    this._tableBuffer = [];
    this._inTable = false;
  }

  // 检查是否在代码块中
  get isInCodeBlock() {
    return false;
  }
}

module.exports = MarkdownRenderer;