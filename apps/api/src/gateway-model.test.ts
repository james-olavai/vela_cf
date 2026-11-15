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
