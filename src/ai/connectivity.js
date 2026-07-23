'use strict';

/**
 * 连通性检测模块
 *
 * 用于测试 AI API 端点是否可达、鉴权是否正确。
 */

const { getClientConfig } = require('./providers');

/**
 * 组装完整 endpoint URL
 * @param {string} baseURL
 * @param {string} format  'openai' | 'anthropic'
 * @returns {string}
 */
function buildEndpoint(baseURL, format) {
  const url = baseURL.replace(/\/+$/, '');
  if (format === 'anthropic') {
    // Anthropic 需要 /v1/messages 路径
    if (!/\/v1\/messages$/.test(url)) {
      return url + '/v1/messages';
    }
    return url;
  }
  // OpenAI 兼容格式需要 /chat/completions 路径
  if (!/\/chat\/completions$/.test(url)) {
    return url + '/chat/completions';
  }
  return url;
}

/**
 * 检测 API 连通性
 * @param {object} opts
 * @param {string} opts.provider  提供商 ID
 * @param {string} opts.model     模型名
 * @param {string} [opts.apiKey]  可覆盖 API Key
 * @param {string} [opts.baseURL] 可覆盖 baseURL
 * @returns {Promise<{ok:boolean, status?:number, latencyMs?:number, error?:string}>}
 */
async function ping(opts = {}) {
  const { provider, model, apiKey, baseURL } = opts;

  if (!provider) {
    return { ok: false, error: '缺少提供商(provider)' };
  }
  if (!model) {
    return { ok: false, error: '缺少模型(model)' };
  }

  let clientConfig;
  try {
    clientConfig = getClientConfig(provider, { apiKey, baseURL, defaultModel: model });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const endpoint = buildEndpoint(clientConfig.baseURL, clientConfig.format);
  const isAnthropic = clientConfig.format === 'anthropic';

  const body = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
  };
  // OpenAI 兼容协议标记不流式；Anthropic 探测不发 stream 字段
  if (!isAnthropic) {
    body.stream = false;
  }

  const headers = {
    'Content-Type': 'application/json',
  };

  if (isAnthropic) {
    headers['x-api-key'] = clientConfig.apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${clientConfig.apiKey || ''}`;
  }

  const start = Date.now();

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(clientConfig.timeout || 10000),
    });

    const latencyMs = Date.now() - start;

    if (resp.ok) {
      return { ok: true, status: resp.status, latencyMs };
    }

    // 尝试解析错误 body
    let detail = '';
    try {
      const errBody = await resp.json();
      detail = errBody.error?.message || errBody.error || JSON.stringify(errBody);
    } catch {
      // body 不是 JSON 就算了
    }

    const status = resp.status;
    if (status === 401 || status === 403) {
      return { ok: false, status, error: `API Key 认证失败: ${detail}`, latencyMs };
    }
    if (status === 404) {
      return { ok: false, status, error: `模型不存在或 baseURL 错误: ${detail}`, latencyMs };
    }
    if (status === 429) {
      return { ok: false, status, error: `请求限流: ${detail}`, latencyMs };
    }
    if (status >= 500) {
      return { ok: false, status, error: `服务器错误: ${detail}`, latencyMs };
    }

    return { ok: false, status, error: `请求失败: ${detail}`, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;

    if (err.name === 'AbortError') {
      return { ok: false, error: '连接超时', latencyMs };
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
      return { ok: false, error: `网络错误: ${err.message}`, latencyMs };
    }

    return { ok: false, error: err.message, latencyMs };
  }
}

module.exports = { ping, buildEndpoint };
