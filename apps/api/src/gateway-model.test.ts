import test from "node:test";
import assert from "node:assert/strict";
import { genkit } from "genkit";
import {
  registerHydrogenGateway,
  toGatewayMessages,
  HYDROGEN_GATEWAY_MODEL,
} from "./gateway-model.js";
test("Gateway保留工具引用和Hydrogen签名且不发送temperature", async () => {
  const original = globalThis.fetch;
  let sent: any;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        model: "gemini-4-hydrogen",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "call-1",
                  function: { name: "natalWheel", arguments: "{}" },
                  extra_content: {
                    google: { thought_signature: "signature-test" },
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
      { status: 200 },
    );
  };
  try {
    const ai = genkit({ plugins: [] });
    const model = registerHydrogenGateway(ai, { token: "test-only" });
    const response = await model({
      messages: [{ role: "user", content: [{ text: "test" }] }],
      config: { temperature: 0.1 },
    });
    assert.equal(sent.model, "gemini-4-hydrogen");
    assert.equal(sent.temperature, undefined);
    const outbound = toGatewayMessages([
      response.message,
      {
        role: "tool",
        content: [
          {
            toolResponse: {
              name: "natalWheel",
              ref: "call-1",
              output: { ok: true },
            },
          },
        ],
      },
    ]);
    assert.equal(outbound[0].tool_calls[0].id, "call-1");
    assert.equal(
      outbound[0].tool_calls[0].extra_content.google.thought_signature,
      "signature-test",
    );
    assert.equal(outbound[1].tool_call_id, "call-1");
    assert.equal(response.usage?.totalTokens, 8);
    assert.ok(HYDROGEN_GATEWAY_MODEL.includes("hydrogen"));
  } finally {
    globalThis.fetch = original;
  }
});

test('Hydrogen Vertex transport validates all tool schemas and preserves streamed tool signatures', async () => {
  const { vertexAI } = await import('@genkit-ai/google-genai');
  const { createAstrologyTools } = await import('./tools.js');
  const original = globalThis.fetch;
  const requests: Array<{ url: string; body: any }> = [];
  let definitions: any;
  function validate(schema: any, path: string) {
    if (!schema) return;
    for (const key of schema.required || []) assert(Object.hasOwn(schema.properties || {}, key), `${path}: required ${key} is absent from wire properties`);
    for (const [key, child] of Object.entries(schema.properties || {})) validate(child, `${path}.${key}`);
    if (schema.items) validate(schema.items, `${path}[]`);
  }
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    assert.match(String(url), /\/locations\/global\/publishers\/google\/models\/gemini-4-hydrogen:streamGenerateContent/);
    assert(!String(url).includes('/interactions'));
    const declarations = requests.at(-1)!.body.tools[0].functionDeclarations;
    assert.equal(declarations.length, 35);
    for (const tool of declarations) {
      validate(tool.parameters, tool.name);
      const original = definitions[tool.name].__action.inputJsonSchema;
      if (original?.properties) assert.deepEqual(Object.keys(tool.parameters.properties).sort(), Object.keys(original.properties).sort(), `${tool.name}: converter dropped an input property`);
    }
    const transit = declarations.find((t: any) => t.name === 'transitEvents').parameters;
    assert.equal(transit.properties.windowMonths.type, 'NUMBER');
    assert.match(transit.properties.windowMonths.description, /3, 6, 12/);
    const parts = requests.length === 1
      ? [{ functionCall: { name: 'transitEvents', args: { birthDateTime: '1994-06-03T08:20', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai', windowMonths: 3, startDate: '2026-11-01' } }, thoughtSignature: 'test-signature' }]
      : [{ text: 'transport verified' }];
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const ai = genkit({ plugins: [vertexAI({ projectId: 'test-project', location: 'global', googleAuth: { authClient: { getAccessToken: async () => ({ token: 'test-only' }) } as any } })] });
    const tools = createAstrologyTools(ai, { revision: 'production-dynamic-tools' });
    definitions = tools;
    const { stream, response } = ai.generateStream({ model: 'vertexai/gemini-4-hydrogen', prompt: 'transport test', tools: Object.values(tools), maxTurns: 3 });
    const [_, result] = await Promise.all([(async () => { for await (const chunk of stream) void chunk; })(), response]);
    assert.equal(result.text, 'transport verified');
    assert.equal(requests.length, 2);
    assert(requests[1].body.contents.some((m: any) => m.parts.some((p: any) => p.thoughtSignature === 'test-signature')));
    const schema = requests[0].body.tools[0].functionDeclarations.find((t: any) => t.name === 'transitEvents').parameters;
    assert(schema.required.includes('birthDateTime'));
    assert(schema.properties.timezone);
    const birth = { birthDateTime: '1994-06-03T08:20', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' };
    await assert.rejects(() => tools.transitEvents({ ...birth, windowMonths: 4 }));
    await assert.rejects(() => tools.transitEvents({ ...birth, windowMonths: '3' }));
  } finally { globalThis.fetch = original; }
});
