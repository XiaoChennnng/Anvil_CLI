'use strict';

const { EventEmitter } = require('events');
const { estimateTokens } = require('../ui/tokens');

class AnvilAIClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config || {};
    this._openai = null;
    this._abortController = null;
  }

  _getClient() {
    if (this._openai) {
      return this._openai;
    }

    const OpenAI = require('openai');

    const options = {
      baseURL: this.config.baseURL || 'https://api.deepseek.com',
      apiKey: this.config.apiKey,
      timeout: this.config.timeout || 60000,
      maxRetries: this.config.retryCount || 2,
    };

    if (this.config.proxy?.https) {
      const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
      options.httpAgent = new HttpsProxyAgent(this.config.proxy.https);
    }

    this._openai = new OpenAI(options);
    return this._openai;
  }

  async chat(messages, options = {}) {
    const model = options.model || this.config.defaultModel || 'deepseek-v4-flash';
    const thinkingMode = options.thinkingMode !== undefined ? options.thinkingMode : true;
    const retryCount = this.config.retryCount || 2;

    const requestOptions = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.tools && options.tools.length > 0) {
      requestOptions.tools = options.tools;
    }

    if (thinkingMode) {
      requestOptions.reasoning_effort = 'high';
      requestOptions.extra_body = {
        thinking: { type: 'enabled' },
      };
    }

    let lastError = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        return await this._doStream(requestOptions, options.signal);
      } catch (err) {
        lastError = err;

        if (err.status === 401 || err.status === 403) {
          throw new Error(`API 认证失败: ${err.message}`);
        }
        if (err.status === 400) {
          throw new Error(`请求参数错误: ${err.message}`);
        }
        if (err.status === 429 && attempt < retryCount) {
          this.emit('status', `速率限制，第 ${attempt + 1} 次重试...`);
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000));
          continue;
        }
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          throw new Error(`无法连接到 API 服务器 (${this.config.baseURL})，请检查网络`);
        }

        if ((err.status >= 500 || err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_HEADERS_TIMEOUT') && attempt < retryCount) {
          this.emit('status', `API 错误，第 ${attempt + 1} 次重试...`);
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
          continue;
        }

        throw err;
      }
    }

    throw lastError || new Error('API 请求失败');
  }

  async _doStream(requestOptions, signal) {
    const client = this._getClient();
    this._abortController = new AbortController();

    // 支持外部取消信号
    const combinedSignal = signal;
    if (combinedSignal) {
      combinedSignal.addEventListener('abort', () => {
        this._abortController.abort();
      });
    }

    const stream = await client.chat.completions.create({
      ...requestOptions,
      signal: this._abortController.signal,
    });

    let thinking = '';
    let content = '';
    const toolCalls = [];
    let currentToolCall = null;
    let usage = null;
    let finishReason = null;

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        const chunkFinishReason = chunk.choices?.[0]?.finish_reason;

        if (chunk.usage) {
          usage = chunk.usage;
          continue;
        }

        if (!delta) {continue;}

        if (delta.reasoning_content) {
          thinking += delta.reasoning_content;
          this.emit('thinking', delta.reasoning_content);
          continue;
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              if (currentToolCall) {
                toolCalls.push(currentToolCall);
              }
              currentToolCall = {
                id: tc.id,
                type: tc.type || 'function',
                function: {
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                },
              };
            } else if (currentToolCall && tc.function?.arguments) {
              currentToolCall.function.arguments += tc.function.arguments;
            }
          }
          continue;
        }

        if (delta.content) {
          content += delta.content;
          this.emit('content', delta.content);
        }

        if (chunkFinishReason) {
          finishReason = chunkFinishReason;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('请求已被中断');
      }
      throw err;
    }

    if (currentToolCall) {
      try {
        currentToolCall.function.arguments = JSON.parse(currentToolCall.function.arguments);
      } catch {
      }
      toolCalls.push(currentToolCall);
    }

    const toolCallsForResponse = toolCalls.map((tc) => ({
      id: tc.id,
      type: tc.type || 'function',
      function: {
        name: tc.function?.name || '',
        arguments: typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments || {}),
      },
    }));

    if (!usage || (!usage.prompt_tokens && !usage.completion_tokens)) {
      const outputText = content + thinking;
      const estimatedOutput = estimateTokens(outputText);
      const inputText = (requestOptions.messages || []).map(m => m.content || '').join('');
      const estimatedInput = estimateTokens(inputText);
      usage = {
        prompt_tokens: estimatedInput || 1,
        completion_tokens: estimatedOutput || 1,
        total_tokens: (estimatedInput || 1) + (estimatedOutput || 1),
      };
    }

    this.emit('usage', usage);

    return {
      thinking,
      content,
      toolCalls: toolCallsForResponse,
      usage,
      finishReason,
    };
  }

  abort() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }
}

module.exports = AnvilAIClient;
