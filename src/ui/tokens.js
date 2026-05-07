'use strict';

// 预编译 CJK 字符正则表达式，避免循环中重复编译
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
  // DeepSeek 价格单位已经是 元/千token，直接使用
  const pricePerKInput = pricing?.input || 0;
  const pricePerKOutput = pricing?.output || 0;
  // 缓存命中价格 = 未命中价格的 1/10
  const pricePerKCacheHit = pricePerKInput / 10;

  const missCost = (cacheMissTokens / 1000) * pricePerKInput;
  const hitCost = (cacheHitTokens / 1000) * pricePerKCacheHit;
  const outputCost = (outputTokens / 1000) * pricePerKOutput;

  return missCost + hitCost + outputCost;
}

function formatTokenUsage(usage, pricing) {
  if (!usage) {return '';}

  const roundTokens = (usage.roundInput || 0) + (usage.roundOutput || 0);
  const totalTokens = (usage.totalInput || 0) + (usage.totalOutput || 0);
  const cacheHit = usage.roundCacheHit || 0;
  const cost = calculateCost(
    (usage.roundInput || 0) - cacheHit,
    cacheHit,
    usage.roundOutput || 0,
    pricing,
  );

  const fmtRound = roundTokens.toLocaleString();
  const fmtTotal = totalTokens.toLocaleString();
  const fmtCost = cost.toFixed(4);

  const parts = [
    `📊 Token: +${fmtRound} (本轮)`,
    `总计: ${fmtTotal}`,
  ];

  // 显示缓存命中率
  if (cacheHit > 0) {
    const hitRate = Math.round((cacheHit / (usage.roundInput || 1)) * 100);
    parts.splice(1, 0, `💾 命中: ${cacheHit.toLocaleString()} (${hitRate}%)`);
  }

  parts.push(`💰 ~¥${fmtCost}`);

  return parts.join(' | ');
}

module.exports = { estimateTokens, calculateCost, formatTokenUsage };
