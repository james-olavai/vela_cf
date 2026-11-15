import { parseBundle, defaultBundle } from "./prompt-bundle.js";
import { getRemoteConfig } from "firebase-admin/remote-config";
import type { Tier, ConsultationMode } from "@vela-cf/shared";
import { DEFAULT_PRESETS, type ServerPresetConfig } from "./prompt-defaults.js";
export { DEFAULT_PRESETS } from "./prompt-defaults.js";
export async function getServerPreset(
  tier: Tier,
  mode?: ConsultationMode,
): Promise<ServerPresetConfig> {
  const fallback = DEFAULT_PRESETS[tier] ?? DEFAULT_PRESETS.free;
  try {
    const defaultConfig: Record<string, string> = {};
    for (const [k, v] of Object.entries(DEFAULT_PRESETS)) {
      defaultConfig[`preset_${k}`] = JSON.stringify(v);
    }
    const template = await getRemoteConfig().getServerTemplate({
      defaultConfig,
    });
    const evaluated = template.evaluate();
    const modeRaw = mode ? evaluated.getString(`preset_${tier}_${mode}`) : "";
    const raw = modeRaw || evaluated.getString(`preset_${tier}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ServerPresetConfig>;
    return parseBundle({
      ...defaultBundle(tier),
      ...parsed,
    }) as unknown as ServerPresetConfig;
  } catch {
    return fallback;
  }
}
