'use strict';

const { EventEmitter } = require('events');
const { estimateTokens } = require('../ui/tokens');
const { getClientConfig, detectProvider, convertImagesInMessages, isVisionModel } = require('./providers');

class AnvilAIClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config || {};
    this._openai = null;
    this._anthropic = null;
    this._abortController = null;
    this._providerConfig = null;
  }

  _initProviderConfig() {
    if (this._providerConfig) {
      return this._providerConfig;
    }

    let providerId = this.config.provider;

    // 没有指定提供商时尝试从模型自动识别
    const modelId = this.config.defaultModel;
    if (!providerId && modelId) {
      providerId = detectProvider(modelId);
    }

    providerId = providerId || 'deepseek';

    try {
      this._providerConfig = getClientConfig(providerId, this.config);
    } catch (err) {
      this.emit('error', `初始化提供商失败: ${err.message}`);
      throw err;
    }

    return this._providerConfig;
  }

  _isAnthropicFormat() {
    const config = this._initProviderConfig();
    if (config.provider === 'anthropic') {
      return true;
    }
    if (config.format === 'anthropic') {
      return true;
    }
    return false;
  }

  _getOpenAIClient() {
    if (this._openai) {
      return this._openai;
    }

    const providerConfig = this._initProviderConfig();
    const OpenAI = require('openai');

    const options = {
      baseURL: providerConfig.baseURL,
      apiKey: providerConfig.apiKey,
      timeout: providerConfig.timeout || 60000,
      maxRetries: providerConfig.retryCount || 2,
    };

    if (this.config.proxy?.https) {
      const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
      options.httpAgent = new HttpsProxyAgent(this.config.proxy.https);
    }

    this._openai = new OpenAI(options);
    return this._openai;
  }

  _getAnthropicClient() {
    if (this._anthropic) {
      return this._anthropic;
    }

    const providerConfig = this._initProviderConfig();
    const Anthropic = require('@anthropic-ai/sdk');

    const options = {
      apiKey: providerConfig.apiKey,
      timeout: providerConfig.timeout || 60000,
      maxRetries: providerConfig.retryCount || 2,
    };

    // Anthropic SDK 不支持直接设置代理，需要通过环境变量或自定义 fetch
    if (this.config.proxy?.https) {
      // Anthropic SDK 使用 undici，需要通过 dispatcher 设置代理
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const proxyAgent = new HttpsProxyAgent(this.config.proxy.https);
      options.httpAgent = proxyAgent;
    }

    this._anthropic = new Anthropic(options);
    return this._anthropic;
  }

  /**
   * 获取当前提供商 ID
   * @returns {string} 提供商 ID
   */
  getCurrentProvider() {
    const config = this._initProviderConfig();
    return config.provider;
  }

  async chat(messages, options = {}) {
    const providerConfig = this._initProviderConfig();

    const model = options.model || this.config.defaultModel || providerConfig.defaultModel;
    const supportsVision = isVisionModel(providerConfig.provider, model);

    let processedMessages = messages;
    if (supportsVision && messages.some(m => m.images && m.images.length > 0)) {
      const format = this._isAnthropicFormat() ? 'anthropic' : 'openai';
      processedMessages = convertImagesInMessages(messages, format);
    }

    if (this._isAnthropicFormat()) {
      return this._chatAnthropic(processedMessages, options, providerConfig);
    }

    return this._chatOpenAI(processedMessages, options, providerConfig);
  }

  async _chatOpenAI(messages, options, providerConfig) {
    const model = options.model || this.config.defaultModel || providerConfig.defaultModel;
    const retryCount = this.config.retryCount || 2;

    // 思考模式:提供商支持且用户未禁用时才启用
    const thinkingMode = providerConfig.thinkingMode
      ? (options.thinkingMode !== undefined ? options.thinkingMode : true)
      : false;

    const requestOptions = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.tools && options.tools.length > 0) {
      requestOptions.tools = options.tools;
    }

    if (thinkingMode && providerConfig.requestFormat?.thinkingType === 'reasoning_effort') {
      requestOptions.reasoning_effort = 'max';
      requestOptions.extra_body = {
        thinking: { type: 'enabled' },
      };
    }

    let lastError = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        return await this._doStreamOpenAI(requestOptions, options.signal, providerConfig);
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
          throw new Error(`无法连接到 API 服务器 (${providerConfig.baseURL})，请检查网络`);
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

  async _chatAnthropic(messages, options, providerConfig) {
    const model = options.model || this.config.defaultModel || providerConfig.defaultModel;
    const retryCount = this.config.retryCount || 2;

    const thinkingMode = providerConfig.thinkingMode
      ? (options.thinkingMode !== undefined ? options.thinkingMode : false)
      : false;

    const anthropicMessages = this._convertToAnthropicMessages(messages);

    const systemMessage = messages.find(m => m.role === 'system');
    const system = systemMessage ? systemMessage.content : undefined;

    const requestOptions = {
      model,
      messages: anthropicMessages,
      max_tokens: 4096,
      stream: true,
    };

    if (system) {
      requestOptions.system = system;
    }

    if (options.tools && options.tools.length > 0) {
      requestOptions.tools = this._convertToAnthropicTools(options.tools);
    }

    if (thinkingMode && model.includes('claude-3-7')) {
      requestOptions.thinking = {
        type: 'enabled',
        budget_tokens: 16000,
      };
      // 思考模式下 max_tokens 必须 > budget_tokens
      requestOptions.max_tokens = 32000;
    }

    let lastError = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        return await this._doStreamAnthropic(requestOptions, options.signal);
      } catch (err) {
        lastError = err;

        // Anthropic 错误码处理(其余分支同 OpenAI)
        if (err.status === 401) {
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
          throw new Error(`无法连接到 API 服务器 (${providerConfig.baseURL})，请检查网络`);
        }

        if ((err.status >= 500 || err.code === 'ETIMEDOUT') && attempt < retryCount) {
          this.emit('status', `API 错误，第 ${attempt + 1} 次重试...`);
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
          continue;
        }

        throw err;
      }
    }

    throw lastError || new Error('API 请求失败');
  }

  _convertToAnthropicMessages(messages) {
    const anthropicMessages = [];

    for (const msg of messages) {
      // 跳过 system 消息，它在 Anthropic 中是单独的参数
      if (msg.role === 'system') {
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls) {
        const content = [];

        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }

        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments,
          });
        }

        anthropicMessages.push({
          role: 'assistant',
          content,
        });
        continue;
      }

      if (msg.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          }],
        });
        continue;
      }

      anthropicMessages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    return anthropicMessages;
  }

  _convertToAnthropicTools(tools) {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }

  async _doStreamOpenAI(requestOptions, signal, providerConfig) {
    const client = this._getOpenAIClient();
    this._abortController = new AbortController();

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

    // 流空闲超时检测: 120 秒无新 chunk 则 abort 触发重试
    const STREAM_IDLE_TIMEOUT = 120 * 1000;
    let lastChunkTime = Date.now();
    const idleTimer = setInterval(() => {
      if (Date.now() - lastChunkTime > STREAM_IDLE_TIMEOUT) {
        clearInterval(idleTimer);
        this._abortController.abort();
      }
    }, 10000);

    try {
      for await (const chunk of stream) {
        lastChunkTime = Date.now();
        const delta = chunk.choices?.[0]?.delta;
        const chunkFinishReason = chunk.choices?.[0]?.finish_reason;

        if (chunk.usage) {
          usage = chunk.usage;
          continue;
        }

        if (!delta) {continue;}

        // 处理思考内容（DeepSeek 特有）
        if (delta.reasoning_content && providerConfig.thinkingMode) {
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
      clearInterval(idleTimer);
      if (err.name === 'AbortError') {
        if (combinedSignal?.aborted) {
          throw new Error('请求已被中断');
        }
        throw new Error(`AI 响应超时：超过 ${STREAM_IDLE_TIMEOUT / 1000} 秒未收到数据`);
      }
      throw err;
    }
    clearInterval(idleTimer);

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

    // 确保缓存命中字段被正确传递（不同提供商命名不同）
    // DeepSeek: prompt_cache_hit_tokens, Kimi: 可能类似, OpenAI: cached_tokens
    if (usage.prompt_cache_hit_tokens === undefined && usage.cached_tokens !== undefined) {
      usage.prompt_cache_hit_tokens = usage.cached_tokens;
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

  async _doStreamAnthropic(requestOptions, signal) {
    const client = this._getAnthropicClient();
    this._abortController = new AbortController();

    // 支持外部取消信号
    const combinedSignal = signal;
    if (combinedSignal) {
      combinedSignal.addEventListener('abort', () => {
        this._abortController.abort();
      });
    }

    const stream = client.messages.stream({
      ...requestOptions,
    }, {
      signal: this._abortController.signal,
    });

    let thinking = '';
    let content = '';
    const toolCalls = [];
    let currentToolUse = null;
    let usage = null;
    let finishReason = null;

    // 流空闲超时检测: 120 秒无新 chunk 则 abort 触发重试
    const STREAM_IDLE_TIMEOUT = 120 * 1000;
    let lastChunkTime = Date.now();
    const idleTimer = setInterval(() => {
      if (Date.now() - lastChunkTime > STREAM_IDLE_TIMEOUT) {
        clearInterval(idleTimer);
        this._abortController.abort();
      }
    }, 10000);

    try {
      for await (const event of stream) {
        lastChunkTime = Date.now();

        // 处理 thinking 块（Claude 3.7 Sonnet 扩展思考）
        if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
          const thinkingText = event.delta.thinking;
          if (thinkingText) {
            thinking += thinkingText;
            this.emit('thinking', thinkingText);
          }
          continue;
        }

        // 处理文本内容
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const text = event.delta.text;
          if (text) {
            content += text;
            this.emit('content', text);
          }
          continue;
        }

        // 处理工具使用开始
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          currentToolUse = {
            id: event.content_block.id,
            type: 'function',
            function: {
              name: event.content_block.name,
              arguments: '',
            },
          };
          continue;
        }

        // 处理工具使用输入
        if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          if (currentToolUse) {
            currentToolUse.function.arguments += event.delta.partial_json;
          }
          continue;
        }

        // 处理工具使用结束
        if (event.type === 'content_block_stop' && currentToolUse) {
          try {
            currentToolUse.function.arguments = JSON.parse(currentToolUse.function.arguments);
          } catch {
            // 解析失败保持字符串
          }
          toolCalls.push(currentToolUse);
          currentToolUse = null;
          continue;
        }

        // 处理停止原因
        if (event.type === 'message_stop') {
          finishReason = 'stop';
        }

        // 处理用量信息（Anthropic 在消息结束时提供）
        if (event.type === 'message_delta' && event.usage) {
          usage = {
            prompt_tokens: event.usage.input_tokens || 0,
            completion_tokens: event.usage.output_tokens || 0,
            total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
          };
        }
      }
    } catch (err) {
      clearInterval(idleTimer);
      if (err.name === 'AbortError') {
        if (combinedSignal?.aborted) {
          throw new Error('请求已被中断');
        }
        throw new Error(`AI 响应超时：超过 ${STREAM_IDLE_TIMEOUT / 1000} 秒未收到数据`);
      }
      throw err;
    }
    clearInterval(idleTimer);

    // 如果还有未完成的 toolUse，添加到列表
    if (currentToolUse) {
      try {
        currentToolUse.function.arguments = JSON.parse(currentToolUse.function.arguments);
      } catch {
      }
      toolCalls.push(currentToolUse);
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

    // Anthropic 可能没有返回用量，需要估算
    if (!usage) {
      const outputText = content + thinking;
      const estimatedOutput = estimateTokens(outputText);
      const inputText = (requestOptions.messages || [])
        .map(m => {
          if (typeof m.content === 'string') {return m.content;}
          if (Array.isArray(m.content)) {
            return m.content.map(c => c.text || '').join('');
          }
          return '';
        })
        .join('');
      const estimatedInput = estimateTokens(inputText);
      usage = {
        prompt_tokens: estimatedInput || 1,
        completion_tokens: estimatedOutput || 1,
        total_tokens: (estimatedInput || 1) + (estimatedOutput || 1),
      };
    }

    // 确保 Anthropic 缓存命中字段被正确传递
    // Anthropic prompt caching 使用不同的字段名
    if (usage.prompt_cache_hit_tokens === undefined) {
      // 尝试其他可能的字段名
      const cachedTokens = usage.prompt_caching_tokens
        || usage.cached_tokens
        || 0;
      if (cachedTokens > 0) {
        usage.prompt_cache_hit_tokens = cachedTokens;
      }
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
