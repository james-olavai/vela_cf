import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, item, i, list) =>
        item.startsWith("--")
          ? [
              ...pairs,
              [
                item.slice(2),
                list[i + 1]?.startsWith("--") ? true : list[i + 1] || true,
              ],
            ]
          : pairs,
      [],
    ),
);
if (!args.baseline || !args.candidate)
  throw new Error("需要 --baseline 配置.json --candidate 配置.json");
let token = process.env.LLM_GATEWAY_TOKEN || process.env.llm_gateway_token;
if (!token) {
  const env = await readFile(".env", "utf8").catch(() => "");
  token = env
    .match(/^llm_gateway_token\s*=\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, "");
}
if (!token) throw new Error("未配置 LLM_GATEWAY_TOKEN");
await mkdir(".playground", { recursive: true });
const runtime = resolve(".playground/ab-gateway-runtime.cjs");
await build({
  stdin: {
    contents:
      'export { genkit } from "genkit"; export { registerHydrogenGateway, HYDROGEN_GATEWAY_MODEL } from "./apps/api/src/gateway-model.ts"; export { generateReading } from "./apps/api/src/generate-reading.ts"; export { parseBundle } from "./apps/api/src/prompt-bundle.ts";',
    resolveDir: process.cwd(),
  },
  outfile: runtime,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["genkit", "@genkit-ai/*", "zod"],
});
const {
  genkit,
  registerHydrogenGateway,
  HYDROGEN_GATEWAY_MODEL,
  generateReading,
  parseBundle,
} = createRequire(import.meta.url)(runtime);
const bundles = {};
for (const key of ["baseline", "candidate"]) {
  const raw = JSON.parse(await readFile(args[key], "utf8"));
  bundles[key] = parseBundle(raw.bundle || raw);
}
const catalog = JSON.parse(
  await readFile(
    args.cases || "apps/api/playground-fixtures/catalog.json",
    "utf8",
  ),
);
const cases = (Array.isArray(catalog) ? catalog : catalog.cases)
  .filter(
    (c) =>
      (!args.case || c.id === args.case) &&
      (!args["case-prefix"] || c.id.startsWith(args["case-prefix"])),
  )
  .slice(0, Number(args.limit || Infinity));
const records = [],
  output = resolve(args.output || ".playground/ab-results.json");
await mkdir(dirname(output), { recursive: true });
const defaults = JSON.parse(
  await readFile("apps/api/playground-fixtures/catalog.json", "utf8"),
);
const repeats = Number(args.repeats || 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10)
  throw new Error("repeats 必须为 1..10");
for (let round = 0; round < repeats; round++)
  for (let index = 0; index < cases.length; index++) {
    const c = cases[index],
      variants =
        (round + index) % 2
          ? ["candidate", "baseline"]
          : ["baseline", "candidate"];
    for (const variant of variants.filter(v => !args.variant || args.variant === v)) {
      const ai = genkit({ plugins: [] }),
        responses = [],
        startedAt = new Date().toISOString();
      const controller = new AbortController(),
        timeout = setTimeout(
          () => controller.abort(),
          Number(args.timeout || 240000),
        );
      registerHydrogenGateway(ai, {
        token,
        maxOutputTokens: args["max-output-tokens"] ? Number(args["max-output-tokens"]) : undefined,
        baseUrl: process.env.LLM_GATEWAY_URL,
        signal: controller.signal,
        onResponse: (record) => responses.push(record),
      });
      const bundle = { ...bundles[variant], modelName: HYDROGEN_GATEWAY_MODEL };
      try {
        const profiles =
          c.profiles ||
          (c.profileIds || ["A"]).map((id) =>
            (catalog.profiles || defaults.profiles).find((p) => p.id === id),
          );
        const result = await generateReading(ai, {
          bundle,
          tier: args.tier || c.tier || "pro",
          profiles,
          message: c.message || c.question,
          historyContext:
            c.historyContext ||
            (c.history || []).map((m) => `${m.role}: ${m.text}`).join("\n"),
          mode: c.mode,
          depth: c.depth || "balanced",
          referenceTime: c.referenceTime,
          signal: controller.signal,
        });
        const incomplete =
          !result.text.trim() || responses.at(-1)?.finishReason === "length";
        records.push({
          incomplete,
          variant,
          round,
          caseId: c.id,
          startedAt,
          input: c,
          responses,
          result,
        });
        console.log(
          `${c.id} ${variant}: ${incomplete ? "输出不完整，不计质量样本" : "完成"} (${responses.length} 次模型调用)`,
        );
      } catch (error) {
        records.push({
          variant,
          round,
          caseId: c.id,
          startedAt,
          responses,
          error: error.name === "AbortError" ? "运行超时" : error.message,
        });
        console.log(`${c.id} ${variant}: 失败`);
      } finally {
        clearTimeout(timeout);
      }
      await writeFile(
        output,
        JSON.stringify(
          {
            schemaVersion: 1,
            model: "gemini-4-hydrogen",
            sampling: "provider-default",
            records,
          },
          null,
          2,
        ),
      );
    }
  }
console.log(`已保存 ${records.length} 次运行至 ${output}`);
