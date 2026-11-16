import { computePortraitSummary } from './portrait.js';
import type { Genkit } from "genkit";
import { natalWheel } from "@vela-cf/astrology";
import {
  extractVelaUiBlocks,
  MAX_OUTPUT_TOKENS_BY_TIER,
  type Tier,
  type AstrologyToolName,
} from "@vela-cf/shared";
import {
  buildNatalFactSummary,
  filterHallucinatedUiBlocks,
  verifyKeySignClaims,
} from "./guard.js";
import { routeTurnCapabilities } from "./skills.js";
import { createAstrologyTools } from "./tools.js";
import {
  bundleHash,
  GUARDRAIL_TAIL,
  parseBundle,
  type PromptBundle,
} from "./prompt-bundle.js";
export async function generateReading(
  ai: Genkit,
  input: {
    bundle: PromptBundle;
    routingText?: {header:string;load:string;direct:string};
    tier: Tier;
    profiles: any[];
    message: string;
    historyContext?: string;
    mode?: string;
    depth?: "quick" | "balanced" | "deep";
    referenceTime?: string;
    toolMode?: string;
    fixtures?: Array<{ toolName: string; input: unknown; output: unknown }>;
    signal?: AbortSignal;
    previewOnly?: boolean;
  },
  emit?: (chunk: any) => void,
) {
  const start = Date.now(),
    bundle = parseBundle(input.bundle),
    calls: any[] = [],
    chart: Record<string, unknown> = {};
  const loadedReferences: Array<{
    skillKey: string;
    title: string;
    reference: string;
    revision: string;
    source: "auto" | "tool";
  }> = [];
  const tierTools = (await import("./prompt-defaults.js")).DEFAULT_PRESETS[
    input.tier
  ].allowedTools;
  const routed = routeTurnCapabilities({
    tier: input.tier,
    routingText: input.routingText,
    skillTexts: bundle.skills,
    depth: input.depth,
    message: input.message,
    profileCount: input.profiles.length,
    sessionAllowedTools: bundle.allowedTools.filter((n) =>
      tierTools.includes(n as AstrologyToolName),
    ) as AstrologyToolName[],
  });
  const canonical = (v: any): string =>
    JSON.stringify(v, (_k, x) =>
      x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, x[k]]),
          )
        : x,
    );
  const all = createAstrologyTools(ai, {
    descriptions: bundle.toolDescriptions,
    skills: bundle.skills,
    revision: bundle.revision,
    execute: async (name, arg, fn) => {
      input.signal?.throwIfAborted();
      const at = Date.now();
      const fixture = input.fixtures?.find(
        (f) => f.toolName === name && canonical(f.input) === canonical(arg),
      );
      if (
        input.toolMode === "fixture" &&
        name !== "loadSkillReference" &&
        !fixture
      )
        throw new Error(`固定盘面未包含技法 ${name} 的此组参数`);
      const output =
        input.toolMode === "fixture" && name !== "loadSkillReference"
          ? fixture!.output
          : await fn();
      if (name === "loadSkillReference") {
        const key = (arg as { skillKey: string }).skillKey;
        const skill = bundle.skills[key];
        loadedReferences.push({
          skillKey: key,
          ...skill,
          revision: bundle.revision,
          source: "tool",
        });
      }
      const chartKey: Record<string, string> = {
        natalWheel: "natal",
        transitEvents: "transits",
        baziPillars: "bazi",
        ziweiPalaces: "ziwei",
      };
      if (chartKey[name]) {
        chart[chartKey[name]] = output;
        if(name === "natalWheel") chart.portrait = computePortraitSummary(output as ReturnType<typeof natalWheel>);
        emit?.({ type: "chart", chart: { ...chart } });
      }
      calls.push({ name, input: arg, output, elapsedMs: Date.now() - at });
      emit?.({ type: "tool", toolName: name, label: `已使用：${name}` });
      return output;
    },
  });
  const p = input.profiles[0];
  const natal = natalWheel({
    birthDateTime: p.birthDateTime,
    latitude: p.latitude,
    longitude: p.longitude,
    timezone: p.timezone,
  });
  chart.natal = natal;
  chart.portrait = computePortraitSummary(natal);
  let index = routed.skillIndexPrompt;
  const catalog = (await import("./skills.js")).SKILL_CATALOG;
  for (const [key, s] of Object.entries(bundle.skills)) {
    const old = catalog[key as keyof typeof catalog];
    index = index.replace(old.title, s.title).replace(old.summary, s.summary);
  }
  for (const [skillKey, definition] of Object.entries(catalog)) {
    if (skillKey === "synthesis_master" &&
        !(routed.routedTools.some((tool) => tool === "natalWheel" || tool === "solarReturn") &&
          routed.routedTools.some((tool) => tool === "baziPillars" || tool === "baziLiunian" || tool === "ziweiPalaces"))) {
      continue;
    }
    if (
      !definition.requiredTools.some((tool) =>
        routed.routedTools.includes(tool),
      )
    )
      continue;
    const skill = bundle.skills[skillKey];
    loadedReferences.push({
      skillKey,
      ...skill,
      revision: bundle.revision,
      source: "auto",
    });
  }
  const referenceContext = loadedReferences
    .map(
      (skill) =>
        `【已加载解读指南：${skill.title} / ${skill.skillKey} / ${skill.revision}】\n${skill.reference}`,
    )
    .join("\n\n");
  const render = (name: keyof PromptBundle["templates"], data: string) =>
    bundle.templates[name].replaceAll("{{data}}", data);
  const system = [
    bundle.systemPrompt,
    GUARDRAIL_TAIL,
    bundle.outputInstructions,
    render("profile", JSON.stringify(input.profiles)),
    render("facts", buildNatalFactSummary(natal)),
    render("route", index),
    referenceContext,
    `参考时间：${input.referenceTime || new Date().toISOString()}`,
  ].join("\n");
  const prompt = `${render("history", input.historyContext || "")}\n用户最新消息：${input.message}`;
  const names = [
    ...routed.routedTools,
    ...(routed.enableSkillLoader ? ["loadSkillReference"] : []),
  ];
  // SDK accepts temperature generally, but Hydrogen's provider ignores it.
  // Do not label a saved/requested sampling value as an effective setting.
  const ignoresTemperature = bundle.modelName.includes("gemini-4-hydrogen");
  const sampling = {
    requestedTemperature: bundle.temperature,
    effectiveTemperature: ignoresTemperature
      ? "provider-default"
      : bundle.temperature,
    ignoredParameters: ignoresTemperature ? ["temperature"] : [],
    parameterNote: ignoresTemperature
      ? "Hydrogen 服务端忽略温度设置，使用模型默认采样行为。"
      : undefined,
  };
  const config = {
    ...(ignoresTemperature ? {} : { temperature: bundle.temperature }),
    maxOutputTokens: MAX_OUTPUT_TOKENS_BY_TIER[input.tier],
  };
  if (input.previewOnly)
    return {
      text: "",
      rawText: "",
      suggestions: [],
      uiBlocks: [],
      chart,
      usage: undefined,
      toolParts: [],
      diagnostics: {
        system,
        prompt,
        tools: names,
        calls,
        loadedReferences,
        hash: bundleHash(bundle),
        revision: bundle.revision,
        model: bundle.modelName,
        parameters: config,
        sampling,
        elapsedMs: Date.now() - start,
        previewOnly: true,
      },
    };
  const { stream, response } = ai.generateStream({
    model: bundle.modelName,
    system,
    prompt,
    tools: names.map((n) => all[n]),
    maxTurns: routed.maxTurns,
    config,
    abortSignal: input.signal,
  });
  void response.catch(() => undefined);
  let rawText = "";
  for await (const c of stream) {
    input.signal?.throwIfAborted();
    if (c.role === "model" && c.text) {
      rawText += c.text;
      emit?.({ type: "text", text: c.text });
    }
  }
  const final = await response;
  if (!rawText) rawText = final.text;
  const extracted = extractVelaUiBlocks(rawText);
  const filtered = filterHallucinatedUiBlocks(
    extracted.uiBlocks,
    natal,
    input.mode === "synastry" || input.profiles.length > 1,
  );
  const verified = verifyKeySignClaims(extracted.cleanText, natal);
  return {
    text: verified.text,
    rawText,
    suggestions: extracted.suggestions,
    uiBlocks: filtered.blocks,
    chart,
    usage: final.usage,
    toolParts: calls.map((c) => ({
      type: "tool-call",
      toolName: c.name,
      label: `已使用：${c.name}`,
    })),
    diagnostics: {
      system,
      prompt,
      tools: names,
      calls,
      loadedReferences,
      hash: bundleHash(bundle),
      revision: bundle.revision,
      model: bundle.modelName,
      parameters: config,
      sampling,
      usage: final.usage,
      finishReason: final.finishReason,
      elapsedMs: Date.now() - start,
      droppedCount: filtered.droppedCount,
      mismatches: verified.mismatches,
    },
  };
}
