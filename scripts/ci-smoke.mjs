#!/usr/bin/env node
import assert from 'node:assert/strict';
import { ALL_34_TOOLS, SKILL_CATALOG } from '../apps/api/src/skills.ts';

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://127.0.0.1:8787/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || 'mock-key';
const LLM_MODEL = process.env.LLM_MODEL || 'mock-vela-model';
const WEB_BASE_URL = process.env.WEB_BASE_URL || '';

async function testLlmGateway() {
  console.log(`[smoke] testing LLM gateway at ${LLM_BASE_URL} (model=${LLM_MODEL}) with all 35 MCP/Genkit tools`);
  assert.equal(ALL_34_TOOLS.length, 34, 'ALL_34_TOOLS must contain 34 astrology tools');
  assert.equal(Object.keys(SKILL_CATALOG).length, 9, 'SKILL_CATALOG must contain 9 skill domains');

  const toolDefs = [
    ...ALL_34_TOOLS.map((name) => ({
      type: 'function',
      function: {
        name,
        description: `Vela astrology tool: ${name}`,
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
    })),
    {
      type: 'function',
      function: {
        name: 'loadSkillReference',
        description: '按需加载指定占星/命理技法的详细 Reference 框架',
        parameters: {
          type: 'object',
          properties: {
            skillKey: { type: 'string', enum: Object.keys(SKILL_CATALOG) },
          },
          required: ['skillKey'],
        },
      },
    },
  ];

  assert.equal(toolDefs.length, 35, 'Total registered tool definitions must be 35');

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
      tools: toolDefs,
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
  console.log('[smoke] LLM tool-calling check passed across 35 tools:', toolCalls[0].function.name);
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

  const astroPreview = await fetch(`${WEB_BASE_URL}/api/astrology`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile: {
        birthDateTime: '1994-06-03T08:20',
        latitude: 31.2304,
        longitude: 121.4737,
        timezone: 'Asia/Shanghai',
      },
    }),
  });
  assert.equal(astroPreview.status, 200, 'POST /api/astrology must return 200');
  const astroJson = await astroPreview.json();
  assert.equal(astroJson.natal?.houseSystem, 'Placidus', 'Natal preview must return Placidus wheel');

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

  // Verify 4-entity mixed synastry (person + person + company + country)
  const fourEntityResp = await fetch(`${WEB_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tier: 'pro',
      mode: 'synastry',
      message: '请分析创始人与公司、国家市场的多方合盘结构',
      profiles: [
        {
          name: '创始人甲',
          entityType: 'person',
          birthDateTime: '1990-04-15T09:30',
          locationName: '上海',
          latitude: 31.2304,
          longitude: 121.4737,
          timezone: 'Asia/Shanghai',
          gender: 'male',
        },
        {
          name: '联合创始人乙',
          entityType: 'person',
          birthDateTime: '1992-08-20T14:10',
          locationName: '北京',
          latitude: 39.9042,
          longitude: 116.4074,
          timezone: 'Asia/Shanghai',
          gender: 'female',
        },
        {
          name: 'Vela Tech',
          entityType: 'company',
          birthDateTime: '2024-01-10T10:00',
          locationName: '新加坡',
          latitude: 1.3521,
          longitude: 103.8198,
          timezone: 'Asia/Singapore',
          gender: 'unset',
        },
        {
          name: '新加坡',
          entityType: 'country',
          birthDateTime: '1965-08-09T09:00',
          locationName: '新加坡',
          latitude: 1.3521,
          longitude: 103.8198,
          timezone: 'Asia/Singapore',
          gender: 'unset',
        },
      ],
    }),
  });
  assert.equal(fourEntityResp.status, 200, '4-entity synastry /api/chat must return 200');
  const fourSse = await fourEntityResp.text();
  assert.ok(fourSse.includes('4 方合盘相位'), '4-entity synastry must emit 4-party synastry tool event');
  assert.ok(fourSse.includes('event: done'), '4-entity synastry must complete');
  console.log('[smoke] Web API + SSE (preview, 2-person & 4-entity person/company/country synastry) E2E check passed');
}

await testLlmGateway();
await testWebEndpoints();
