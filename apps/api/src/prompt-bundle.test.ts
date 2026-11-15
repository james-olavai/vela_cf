import test from "node:test";
import assert from "node:assert/strict";
import { genkit } from "genkit";
import {
  defaultBundle,
  parseBundle,
  bundleHash,
  GUARDRAIL_TAIL,
} from "./prompt-bundle.js";
import { createAstrologyTools } from "./tools.js";
test("配置校验、默认补齐和独立快照", () => {
  const a = defaultBundle("pro"),
    b = defaultBundle("pro");
  a.skills.western_natal.reference = "new";
  assert.notEqual(bundleHash(a), bundleHash(b));
  assert.notEqual(
    a.skills.western_natal.reference,
    b.skills.western_natal.reference,
  );
  assert.throws(() => parseBundle({ ...a, temperature: 3 }));
  assert.throws(() =>
    parseBundle({ ...a, templates: { ...a.templates, profile: "{{secret}}" } }),
  );
  assert.ok(GUARDRAIL_TAIL.includes("事实"));
  assert.ok(parseBundle({ ...b, skills: {} }).skills.western_natal);
});
test("并发工具 Reference 使用运行快照，不修改全局注册", async () => {
  const ai = genkit({ plugins: [] }),
    a = defaultBundle("pro"),
    b = defaultBundle("pro");
  a.skills.western_natal.reference = "A";
  b.skills.western_natal.reference = "B";
  const toolsA = createAstrologyTools(ai, { skills: a.skills, revision: "A" }),
    toolsB = createAstrologyTools(ai, { skills: b.skills, revision: "B" });
  const [ra, rb] = await Promise.all([
    toolsA.loadSkillReference({ skillKey: "western_natal" }),
    toolsB.loadSkillReference({ skillKey: "western_natal" }),
  ]);
  assert.equal((ra as any).reference, "A");
  assert.equal((rb as any).reference, "B");
});

test("普通本命解读确定性注入相关指南，排除无关技法", async () => {
  const { generateReading } = await import("./generate-reading.js");
  const bundle = defaultBundle("free");
  bundle.skills.western_natal.reference = "本命指南测试标记";
  bundle.skills.eastern_ziwei.reference = "不应注入的紫微指南";
  const result = await generateReading(genkit({ plugins: [] }), {
    bundle,
    tier: "free",
    message: "我的性格特点是什么？",
    previewOnly: true,
    profiles: [
      {
        name: "A",
        birthDateTime: "1990-06-15T14:30",
        latitude: 39.9042,
        longitude: 116.4074,
        timezone: "Asia/Shanghai",
      },
    ],
  });
  assert.ok(result.diagnostics.system.includes("本命指南测试标记"));
  assert.ok(!result.diagnostics.system.includes("不应注入的紫微指南"));
  assert.ok(
    !result.diagnostics.loadedReferences.some(
      (reference) => reference.skillKey === "synthesis_master",
    ),
  );
  assert.equal(
    result.diagnostics.loadedReferences.find(
      (r) => r.skillKey === "western_natal",
    )?.source,
    "auto",
  );
});

test("Hydrogen不伪称temperature生效，模型调用使用完整指南", async () => {
  const { generateReading } = await import("./generate-reading.js");
  const ai = genkit({ plugins: [] });
  const captured: any[] = [];
  const fakeAi = {
    defineTool: ai.defineTool.bind(ai),
    generateStream(request: any) {
      captured.push(request);
      return {
        stream: (async function* () {
          yield { role: "model", text: "测试回答" };
        })(),
        response: Promise.resolve({
          text: "测试回答",
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      };
    },
  };
  for (const temperature of [0.2, 1.2]) {
    const bundle = defaultBundle("free");
    bundle.modelName = "vertexai/gemini-4-hydrogen";
    bundle.temperature = temperature;
    bundle.skills.western_natal.reference = `候选指南 ${temperature}`;
    const result = await generateReading(fakeAi as any, {
      bundle,
      tier: "free",
      message: "我的性格特点是什么？",
      profiles: [
        {
          name: "A",
          birthDateTime: "1990-06-15T14:30",
          latitude: 39.9042,
          longitude: 116.4074,
          timezone: "Asia/Shanghai",
        },
      ],
    });
    assert.equal(result.diagnostics.sampling.requestedTemperature, temperature);
    assert.equal(
      result.diagnostics.sampling.effectiveTemperature,
      "provider-default",
    );
    assert.deepEqual(result.diagnostics.sampling.ignoredParameters, [
      "temperature",
    ]);
    assert.ok(result.diagnostics.system.includes(`候选指南 ${temperature}`));
  }
  assert.deepEqual(
    captured.map((r) => r.config.temperature),
    [undefined, undefined],
  );
});

test("Genkit实际模型请求包含Zod4行运参数与必填字段", async () => {
  const ai = genkit({ plugins: [] });
  let captured: any;
  const model = ai.defineModel(
    {
      name: "test/schema-capture",
      supports: { tools: true, multiturn: true, systemRole: true },
    },
    async (request) => {
      captured = request;
      return {
        message: { role: "model", content: [{ text: "schema captured" }] },
        finishReason: "stop",
      };
    },
  );
  const tools = createAstrologyTools(ai, { revision: "schema-test" });
  await ai.generate({
    model,
    prompt: "test",
    tools: [tools.transitEvents, tools.natalWheel],
  });
  const transit = captured.tools.find(
    (t: any) => t.name === "transitEvents",
  ).inputSchema;
  assert.ok(transit.properties.windowMonths);
  assert.ok(transit.properties.startDate);
  for (const key of ["birthDateTime", "latitude", "longitude", "timezone"]) {
    assert.ok(transit.properties[key]);
    assert.ok(transit.required.includes(key));
  }
});

test("发布快照不隐式补默认，内容哈希不依赖对象键顺序", async () => {
  const { parseCompleteBundle } = await import("./prompt-bundle.js");
  const bundle = defaultBundle("go");
  assert.deepEqual(parseCompleteBundle(bundle), bundle);
  assert.throws(() => parseCompleteBundle({ ...bundle, skills: {} }));
  assert.throws(() => parseCompleteBundle({ ...bundle, toolDescriptions: {} }));
  assert.throws(() => parseCompleteBundle({ ...bundle, templates: { ...bundle.templates, facts: "{{{data}}}" } }));
  const reordered = Object.fromEntries(Object.entries(bundle).reverse());
  reordered.skills = Object.fromEntries(Object.entries(bundle.skills).reverse());
  assert.equal(bundleHash(bundle), bundleHash(reordered as typeof bundle));
});
