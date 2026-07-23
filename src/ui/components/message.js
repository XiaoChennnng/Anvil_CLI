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

    // 提取 <think> 思考块（部分模型如 MiniMax 会嵌入到文本中）渲染为灰色斜体
    const thinkLines = [];
    content = content.replace(/<think>([\s\S]*?)<\/think>/g, (_, thinkContent) => {
      const lines = thinkContent.trim().split('\n').filter(l => l.trim());
      for (const line of lines) {
        thinkLines.push(` ${marker} ${t.thinking(line.trim())}`);
      }
      return '';
    });

    const rendered = this.markdown.write(content.endsWith('\n') ? content : content + '\n');
    const result = [...thinkLines];
    for (const line of rendered.split('\n')) {
      if (line.trim()) {
        result.push(` ${marker} ${line}`);
      }
    }
    for (const infoLine of info) {
      result.push(` ${marker} ${t.textMuted(infoLine)}`);
    }

    return result;
  }

  renderToolCall(toolCall, width, nested = false, status = 'pending', blinkVisible = true) {
    return this.toolRenderer.renderToolCall(toolCall, width, nested, true, status, blinkVisible);
  }

  renderToolResponse(name, result, toolCall, width, maxLines = 10) {
    return this.toolRenderer.renderToolResponse(name, result, toolCall, width, maxLines);
  }
}

module.exports = MessageRenderer;
