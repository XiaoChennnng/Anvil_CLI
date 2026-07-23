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

    // Anthropic SDK 内部会追加 /v1/messages，如果 baseURL 以 /v1 结尾则去掉
    // 避免用户习惯性输入 OpenAI 格式的 /v1 导致双 /v1
    let baseURL = providerConfig.baseURL;
    if (baseURL && baseURL.replace(/\/+$/, '').endsWith('/v1')) {
      baseURL = baseURL.replace(/\/+$/, '').slice(0, -3);
    }

    const options = {
      baseURL,
      apiKey: providerConfig.apiKey,
      timeout: providerConfig.timeout || 60000,
      maxRetries: providerConfig.retryCount || 2,
    };

    // 自定义 fetch 支持代理（Anthropic SDK 使用 undici）
    if (this.config.proxy?.https) {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const proxyAgent = new HttpsProxyAgent(this.config.proxy.https);
      options.httpAgent = proxyAgent;
    }

    this._anthropic = new Anthropic(options);
    return this._anthropic;
  }

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

    // 思考模式：提供商支持且用户未禁用时才启用
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

    // reasoning_split：让思考内容走 reasoning_content 字段而非嵌入 <think> 标签，方便 TUI 区分渲染
    // 支持方式：1) provider.requestFormat.reasoningSplit 显式 2) 模型名自动匹配 MiniMax
    const enableReasoningSplit = providerConfig.requestFormat?.reasoningSplit
      || /^MiniMax-M/i.test(model);
    if (thinkingMode && enableReasoningSplit) {
      requestOptions.extra_body = {
        ...requestOptions.extra_body,
        reasoning_split: true,
      };
    }

    let lastError = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        return await this._doStreamOpenAI(requestOptions, options.signal, providerConfig);
      } catch (err) {
        lastError = err;

        if (err.name === 'AbortError') {
          if (options.signal?.aborted) {
            throw new Error('请求已被中断');
          }
          throw new Error(`AI 响应超时：超过 120 秒未收到数据`);
        }

        if (err.status === 401 || err.status === 403) {
          const formatHint = (err.message && err.message.includes('x-api-key'))
            ? '\n  [Anvil] 服务器要求 x-api-key 认证（Anthropic 协议），但你配的是 OpenAI 格式。请将该 provider 的 format 设为 "anthropic"。'
            : '';
          throw new Error(`API 认证失败: ${err.message}${formatHint}`);
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

        if ((err.status >= 500 || err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_HEADERS_TIMEOUT' || err.code === 'STREAM_TERMINATED') && attempt < retryCount) {
          this.emit('status', `API 连接中断，第 ${attempt + 1} 次重试...`);
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

    // 收集所有 system 消息（Tier 0/1/1.5）用于 Anthropic system 参数
    const systemBlocks = this._buildAnthropicSystemBlocks(messages);

    const requestOptions = {
      model,
      messages: anthropicMessages,
      max_tokens: 4096,
      stream: true,
    };

    if (systemBlocks.length > 0) {
      requestOptions.system = systemBlocks;
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

        if (err.name === 'AbortError') {
          if (options.signal?.aborted) {
            throw new Error('请求已被中断');
          }
          throw new Error(`AI 响应超时：超过 120 秒未收到数据`);
        }

        // Anthropic 错误码处理（其余分支同 OpenAI）
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

        if ((err.status >= 500 || err.code === 'ETIMEDOUT' || err.code === 'STREAM_TERMINATED') && attempt < retryCount) {
          this.emit('status', `API 连接中断，第 ${attempt + 1} 次重试...`);
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

  /**
   * 构建 Anthropic system blocks，将所有 system 消息转为 content blocks
   * 并在最后一个 block 上添加 cache_control 断点以提高缓存命中率
   */
  _buildAnthropicSystemBlocks(messages) {
    const blocks = messages
      .filter(m => m.role === 'system')
      .map((m, i, arr) => {
        const block = { type: 'text', text: m.content || '' };
        if (i === arr.length - 1) {
          block.cache_control = { type: 'ephemeral' };
        }
        return block;
      })
      .filter(b => b.text);
    return blocks;
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

    // 流空闲超时：120 秒无新 chunk 则 abort 触发重试
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
      // Node.js undici 连接被服务端终止时抛出 TypeError: terminated，标记为重试
      if (err.name === 'TypeError' && /terminated/i.test(err.message)) {
        throw Object.assign(err, { code: 'STREAM_TERMINATED' });
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

    // 统一缓存命中字段：DeepSeek=prompt_cache_hit_tokens, Kimi=prompt_caching_tokens, OpenAI=cached_tokens
    if (usage.prompt_cache_hit_tokens === undefined) {
      const cachedTokens = usage.cached_tokens
        || usage.prompt_caching_tokens
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

  async _doStreamAnthropic(requestOptions, signal) {
    const client = this._getAnthropicClient();
    this._abortController = new AbortController();

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

    // 流空闲超时：120 秒无新 chunk 则 abort 触发重试
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

        if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
          const thinkingText = event.delta.thinking;
          if (thinkingText) {
            thinking += thinkingText;
            this.emit('thinking', thinkingText);
          }
          continue;
        }

        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const text = event.delta.text;
          if (text) {
            content += text;
            this.emit('content', text);
          }
          continue;
        }

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

        if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          if (currentToolUse) {
            currentToolUse.function.arguments += event.delta.partial_json;
          }
          continue;
        }

        if (event.type === 'content_block_stop' && currentToolUse) {
          try {
            currentToolUse.function.arguments = JSON.parse(currentToolUse.function.arguments);
          } catch {
            // 解析失败保留原始字符串
          }
          toolCalls.push(currentToolUse);
          currentToolUse = null;
          continue;
        }

        if (event.type === 'message_stop') {
          finishReason = 'stop';
        }

        // Anthropic 在 message_delta 事件携带用量
        if (event.type === 'message_delta' && event.usage) {
          usage = {
            prompt_tokens: event.usage.input_tokens || 0,
            completion_tokens: event.usage.output_tokens || 0,
            total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
            cache_read_input_tokens: event.usage.cache_read_input_tokens || 0,
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
      // 连接被服务端终止，标记为重试
      if (err.name === 'TypeError' && /terminated/i.test(err.message)) {
        throw Object.assign(err, { code: 'STREAM_TERMINATED' });
      }
      throw err;
    }
    clearInterval(idleTimer);

    // 流结束还有未闭合的 toolUse 也加入列表
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

    // Anthropic 可能不返回用量，按字符数估算兜底
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

    // 统一缓存命中字段：Anthropic=cache_read_input_tokens, Kimi=prompt_caching_tokens, OpenAI=cached_tokens
    if (usage.prompt_cache_hit_tokens === undefined) {
      const cachedTokens = usage.cache_read_input_tokens
        || usage.prompt_caching_tokens
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
