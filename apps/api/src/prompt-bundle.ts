import { TOOL_DESCRIPTIONS } from "./tools.js";
import { createHash } from "node:crypto";
import { z } from "genkit";
import { DEFAULT_PRESETS, GUARDRAIL_TAIL } from "./prompt-defaults.js";
import { ALL_34_TOOLS, SKILL_CATALOG } from "./skills.js";
import type { Tier } from "@vela-cf/shared";
export const OUTPUT_INSTRUCTIONS =
  "必要时在正文末尾附带 :::vela-ui 纯 JSON 块，component 限 aspect-highlight、transit-timeline、synastry-meter。最后另起一行 SUGGESTIONS: 后跟两个简短追问，以 | 分隔。";
const text = z.string().min(1).max(30000);
export const BundleSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    productId: z.string().default("personal"),
    revision: text.default("draft"),
    systemPrompt: text,
    outputInstructions: text,
    modelName: text,
    temperature: z.number().min(0).max(2),
    allowedTools: z
      .array(z.enum(ALL_34_TOOLS as [string, ...string[]]))
      .max(34),
    skills: z.record(
      z.string(),
      z.object({ title: text, summary: text, reference: text }),
    ),
    toolDescriptions: z.record(z.string(), text),
    templates: z.object({
      profile: text,
      facts: text,
      history: text,
      route: text,
    }),
  })
  .strict();
export type PromptBundle = z.infer<typeof BundleSchema>;
export function defaultBundle(
  tier: Tier,
  productId: string = tier,
): PromptBundle {
  return BundleSchema.parse({
    ...DEFAULT_PRESETS[tier],
    schemaVersion: 1,
    productId,
    revision: "default-v1",
    outputInstructions: OUTPUT_INSTRUCTIONS,
    skills: Object.fromEntries(
      Object.entries(SKILL_CATALOG).map(([k, v]) => [
        k,
        { title: v.title, summary: v.summary, reference: v.reference },
      ]),
    ),
    toolDescriptions: { ...TOOL_DESCRIPTIONS },
    templates: {
      profile: "档案资料：{{data}}",
      facts: "已验证盘面：{{data}}",
      history: "{{data}}",
      route: "{{data}}",
    },
  });
}
export function parseBundle(value: unknown): PromptBundle {
  const b = BundleSchema.parse(value);
  b.skills = {
    ...Object.fromEntries(
      Object.entries(SKILL_CATALOG).map(([k, v]) => [
        k,
        { title: v.title, summary: v.summary, reference: v.reference },
      ]),
    ),
    ...b.skills,
  };
  for (const key of Object.keys(b.skills))
    if (!(key in SKILL_CATALOG)) throw new Error(`未知技法：${key}`);
  for (const key of Object.keys(b.toolDescriptions))
    if (![...ALL_34_TOOLS, "loadSkillReference"].includes(key))
      throw new Error(`未知工具：${key}`);
  for (const template of Object.values(b.templates))
    if (!template.includes("{{data}}") || /{{(?!data}})/.test(template))
      throw new Error("模板需要保留 {{data}}，不支持其他变量");
  return b;
}
export function bundleHash(bundle: PromptBundle) {
  return createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
}
export { GUARDRAIL_TAIL };
