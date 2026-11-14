#!/usr/bin/env node
import assert from 'node:assert/strict';

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://127.0.0.1:8787/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || 'mock-key';
const LLM_MODEL = process.env.LLM_MODEL || 'mock-vela-model';
const WEB_BASE_URL = process.env.WEB_BASE_URL || '';

async function testLlmGateway() {
  console.log(`[smoke] testing LLM gateway at ${LLM_BASE_URL} (model=${LLM_MODEL})`);
  const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.2,
      max_tokens: 300,
      tools: [
        {
          type: 'function',
          function: {
            name: 'natalWheel',
            description: '计算西洋占星本命盘',
            parameters: {
              type: 'object',
              properties: {
                birthDateTime: { type: 'string' },
                latitude: { type: 'number' },
                longitude: { type: 'number' },
                timezone: { type: 'string' },
              },
              required: ['birthDateTime', 'latitude', 'longitude', 'timezone'],
            },
          },
        },
      ],
      messages: [
        {
          role: 'system',
          content: '你是占星顾问，请先调用 natalWheel 工具获取星盘。',
        },
        {
          role: 'user',
          content: '帮我看一下 1994-06-03T08:20 上海（31.2304, 121.4737, Asia/Shanghai）的本命盘。',
        },
      ],
    }),
  });

  assert.equal(resp.status, 200, `LLM gateway status expected 200, got ${resp.status}`);
  const data = await resp.json();
  const choice = data.choices?.[0];
  assert.ok(choice, 'LLM gateway returned no choices');
  const toolCalls = choice.message?.tool_calls ?? [];
  assert.ok(toolCalls.length > 0, 'Expected model to invoke natalWheel tool_call');
  assert.equal(toolCalls[0].function?.name, 'natalWheel');
  console.log('[smoke] LLM tool-calling check passed:', toolCalls[0].function.name);
}

async function testWebEndpoints() {
  if (!WEB_BASE_URL) return;
  console.log(`[smoke] testing web endpoints at ${WEB_BASE_URL}`);

  const home = await fetch(`${WEB_BASE_URL}/`);
  assert.equal(home.status, 200, 'GET / must return 200');

  const loc = await fetch(`${WEB_BASE_URL}/api/locations?q=${encodeURIComponent('上海')}`);
  assert.equal(loc.status, 200, 'GET /api/locations must return 200');
  const locJson = await loc.json();
  assert.ok(Array.isArray(locJson.results) && locJson.results.length > 0, 'Location results non-empty');

  const chatResp = await fetch(`${WEB_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tier: 'pro',
      mode: 'synastry',
      message: '请分析双人合盘',
      profiles: [
        {
          name: '测试甲',
          entityType: 'person',
          birthDateTime: '1994-06-03T08:20',
          locationName: '上海',
          latitude: 31.2304,
          longitude: 121.4737,
          timezone: 'Asia/Shanghai',
          gender: 'male',
        },
        {
          name: '测试乙',
          entityType: 'person',
          birthDateTime: '1996-09-12T14:30',
          locationName: '北京',
          latitude: 39.9042,
          longitude: 116.4074,
          timezone: 'Asia/Shanghai',
          gender: 'female',
        },
      ],
    }),
  });
  assert.equal(chatResp.status, 200, 'POST /api/chat must return 200');
  const sseText = await chatResp.text();
  assert.ok(sseText.includes('event: chart'), 'SSE must emit chart event');
  assert.ok(sseText.includes('event: delta'), 'SSE must emit delta event');
  assert.ok(sseText.includes('event: done'), 'SSE must emit done event');
  console.log('[smoke] Web API + SSE E2E check passed');
}

await testLlmGateway();
await testWebEndpoints();
