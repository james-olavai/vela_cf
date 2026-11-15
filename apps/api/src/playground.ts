import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { genkit, z } from "genkit";
import { vertexAI } from "@genkit-ai/google-genai";
import { DEFAULT_PRESETS, GUARDRAIL_TAIL } from "./prompt-defaults.js";
import { defaultBundle, parseBundle } from "./prompt-bundle.js";
import { generateReading } from "./generate-reading.js";
import { SKILL_CATALOG } from "./skills.js";
import { NatalWheelInputSchema } from "@vela-cf/astrology";
const token = randomBytes(32).toString("hex");
const productPath = resolve(
  process.cwd(),
  "apps/api/playground-fixtures/products.json",
);
const products = (
  JSON.parse(readFileSync(productPath, "utf8")) as Array<{
    id: string;
    name: string;
    tier: "free" | "go" | "pro";
    bundle?: unknown;
  }>
).map((p) => ({
  ...p,
  bundle: p.bundle ? parseBundle(p.bundle) : defaultBundle(p.tier, p.id),
}));
const ai = genkit({ plugins: [vertexAI({ location: "global" })] });
const RunSchema = z.object({
  productId: z.string(),
  bundle: z.unknown().optional(),
  profiles: z
    .array(
      z
        .object({
          birthDateTime: z.string(),
          latitude: z.number(),
          longitude: z.number(),
          timezone: z.string(),
        })
        .passthrough(),
    )
    .min(1)
    .max(4),
  message: z.string().trim().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(20000),
      }),
    )
    .max(20)
    .optional(),
  depth: z.enum(["quick", "balanced", "deep"]).optional(),
  referenceTime: z.string().datetime().optional(),
  toolMode: z.enum(["live", "fixture"]).default("live"),
  fixtures: z
    .array(
      z.object({
        toolName: z.string(),
        input: z.unknown(),
        output: z.unknown(),
      }),
    )
    .optional(),
  previewOnly: z.boolean().optional(),
});
async function run(raw: unknown, signal?: AbortSignal) {
  const input = RunSchema.parse(raw),
    product = products.find((p) => p.id === input.productId);
  if (!product) throw new Error("未找到此产品，请重新选择");
  if (
    input.profiles.length >
    (product.tier === "pro" ? 4 : product.tier === "go" ? 2 : 1)
  )
    throw new Error("此产品不支持所选档案数量");
  for (const profile of input.profiles) NatalWheelInputSchema.parse(profile);
  if (
    product.tier !== "pro" &&
    input.profiles.some((p) => p.entityType && p.entityType !== "person")
  )
    throw new Error("此产品不支持公司或国家档案");
  const bundle = input.bundle ? parseBundle(input.bundle) : product.bundle;
  const fixedPath = resolve(
    process.cwd(),
    "apps/api/playground-fixtures/fixed-results.json",
  );
  const fixtures =
    input.fixtures ||
    (input.toolMode === "fixture" && existsSync(fixedPath)
      ? JSON.parse(readFileSync(fixedPath, "utf8")).entries
      : undefined);
  return generateReading(ai, {
    ...input,
    fixtures,
    bundle,
    tier: product.tier as any,
    mode: input.profiles.length > 1 ? "synastry" : "personal",
    historyContext: input.history
      ?.map((m) => `${m.role === "user" ? "用户" : "顾问"}：${m.text}`)
      .join("\n"),
    signal,
  });
}
ai.defineFlow(
  { name: "promptPlayground", inputSchema: RunSchema },
  async (input) => run(input),
);
function catalog() {
  const path = resolve(
    process.cwd(),
    "apps/api/playground-fixtures/catalog.json",
  );
  const data = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { profiles: [], cases: [] };
  const f = resolve(
    process.cwd(),
    "apps/api/playground-fixtures/fixed-results.json",
  );
  const fixtures = existsSync(f)
    ? JSON.parse(readFileSync(f, "utf8")).entries
    : [];
  return {
    ...data,
    cases: data.cases.map((c: any) => ({
      ...c,
      name: c.title,
      profiles: c.profileIds.map((id: string) =>
        data.profiles.find((p: any) => p.id === id),
      ),
      fixtures,
    })),
  };
}
const port = Number(process.env.PLAYGROUND_API_PORT || 4311);
createServer(async (req, res) => {
  const host = req.headers.host || "",
    origin = req.headers.origin;
  if (
    !/^((localhost)|(127\.0\.0\.1)):\d+$/.test(host) ||
    (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (req.method === "GET" && req.url === "/api/playground/bootstrap") {
      const ready =
        !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        existsSync(
          resolve(
            homedir(),
            ".config/gcloud/application_default_credentials.json",
          ),
        );
      res.end(
        JSON.stringify({
          token,
          products,
          skills: SKILL_CATALOG,
          guardrails: GUARDRAIL_TAIL,
          ready,
          ...catalog(),
        }),
      );
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/playground/run") {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "请刷新工作台后重试" }));
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 2_000_000) throw new Error("输入内容过大");
    }
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const result = await run(JSON.parse(body), abort.signal);
    if (!res.destroyed) res.end(JSON.stringify(result));
  } catch (error) {
    if (!res.destroyed) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "运行失败",
        }),
      );
    }
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Playground API: http://127.0.0.1:${port}`),
);
