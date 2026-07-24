'use strict';

const CJK_PATTERN = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

function estimateTokens(text) {
  if (!text) {return 0;}
  let count = 0;
  for (const char of text) {
    if (CJK_PATTERN.test(char)) {
      count += 1.5;
    } else {
      count += 0.25;
    }
  }
  return Math.ceil(count);
}

function calculateCost(cacheMissTokens, cacheHitTokens, outputTokens, pricing) {
  // DeepSeek 价格单位是 元/千token
  const pricePerKInput = pricing?.input || 0;
  const pricePerKOutput = pricing?.output || 0;
  // 缓存命中价格：优先用模型定义的 cachedInput，没有则按 input 的 1/10
  const pricePerKCacheHit = pricing?.cachedInput !== undefined ? pricing.cachedInput : pricePerKInput / 10;

  const missCost = (cacheMissTokens / 1000) * pricePerKInput;
  const hitCost = (cacheHitTokens / 1000) * pricePerKCacheHit;
  const outputCost = (outputTokens / 1000) * pricePerKOutput;

  return missCost + hitCost + outputCost;
}

module.exports = { estimateTokens, calculateCost };
