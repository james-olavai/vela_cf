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
