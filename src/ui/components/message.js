'use strict';

const chalk = require('chalk');
const { getTheme } = require('../theme');
const MarkdownRenderer = require('../markdown');
const ToolRenderer = require('../tool-renderer');

class MessageRenderer {
  constructor() {
    this.theme = getTheme();
    this.markdown = new MarkdownRenderer();
    this.toolRenderer = new ToolRenderer(this.theme);
  }

  renderMessage(content, isUser, width, info = []) {
    const t = this.theme;
    const borderColor = isUser ? t.colors.secondary : t.colors.primary;
    const marker = chalk.hex(borderColor)('●');

    // Markdown 渲染
    const contentWithNewline = content.endsWith('\n') ? content : content + '\n';
    const rendered = this.markdown.write(contentWithNewline);
    const lines = rendered.split('\n');

    // 过滤空行
    const result = [];
    for (const line of lines) {
      if (line.trim()) {
        result.push(` ${marker} ${line}`);
      }
    }

    // 添加额外信息
    for (const infoLine of info) {
      result.push(` ${marker} ${t.textMuted(infoLine)}`);
    }

    return result;
  }

  renderToolCall(toolCall, width, nested = false) {
    return this.toolRenderer.renderToolCall(toolCall, width, nested);
  }

  renderToolResponse(name, result, toolCall, width, maxLines = 10) {
    return this.toolRenderer.renderToolResponse(name, result, toolCall, width, maxLines);
  }
}

module.exports = MessageRenderer;
