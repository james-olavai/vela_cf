import { TOOL_DESCRIPTIONS } from "./tools.js";
import { createHash } from "node:crypto";
import { z } from "genkit";
import { DEFAULT_PRESETS, GUARDRAIL_TAIL } from "./prompt-defaults.js";
import { ALL_34_TOOLS, SKILL_CATALOG } from "./skills.js";
import type { Tier } from "@vela-cf/shared";
import { PROMPT_TEXT } from "./prompt-resources.generated.js";
export const OUTPUT_INSTRUCTIONS = PROMPT_TEXT.outputInstructions;
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
    revision: "consultation-guides-v4",
    outputInstructions: OUTPUT_INSTRUCTIONS,
    skills: Object.fromEntries(
      Object.entries(SKILL_CATALOG).map(([k, v]) => [
        k,
        { title: v.title, summary: v.summary, reference: v.reference },
      ]),
    ),
    toolDescriptions: { ...TOOL_DESCRIPTIONS },
    templates: { ...PROMPT_TEXT.templates },
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
/** Release/evaluation snapshots must be complete; legacy defaults are opt-in elsewhere. */
export function parseCompleteBundle(value: unknown): PromptBundle {
  if (!value || typeof value !== "object" ||
      ["schemaVersion", "productId", "revision"].some(key => !Object.hasOwn(value, key)))
    throw new Error("完整快照必须显式包含契约、产品与修订版本");
  const bundle = BundleSchema.parse(value);
  if (new Set(bundle.allowedTools).size !== bundle.allowedTools.length)
    throw new Error("工具权限不能重复");
  const expectedSkills = Object.keys(SKILL_CATALOG).sort();
  const expectedTools = [...ALL_34_TOOLS, "loadSkillReference"].sort();
  if (JSON.stringify(Object.keys(bundle.skills).sort()) !== JSON.stringify(expectedSkills))
    throw new Error("完整快照必须包含全部已登记技法");
  if (JSON.stringify(Object.keys(bundle.toolDescriptions).sort()) !== JSON.stringify(expectedTools))
    throw new Error("完整快照必须包含全部已登记工具说明");
  for (const template of Object.values(bundle.templates)) {
    if (!template.includes("{{data}}") || /{{(?!data}})/.test(template) || template.includes("{{{"))
      throw new Error("模板只支持 {{data}}，不得包含其他模板表达式");
  }
  return bundle;
}
export function bundleHash(bundle: PromptBundle) {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(canonical) :
    value !== null && typeof value === "object" ? Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => [key, canonical(entry)]),
    ) : value;
  return createHash("sha256").update(JSON.stringify(canonical(bundle))).digest("hex");
}
export { GUARDRAIL_TAIL };
