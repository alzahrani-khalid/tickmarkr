// The world the fleet tests run in: stub adapters, hand-written doctor results, a fixed clock and
// one small config. Shared by every test file in this folder; it calls no model and reads no disk.
import { allAdapters } from "../../src/adapters/registry.js";
import type { AuthHealth } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import type { FleetInputs } from "../../src/fleet/model.js";

export const adapters = allAdapters({ operatorYaml: null, operatorPath: false });
export const NOW = Date.parse("2026-11-11T00:00:00Z");
/** Every default model answered yesterday, except the ones named in `dead`. */
export function health(dead: string[] = [], extra: Record<string, string[]> = {}): Record<string, AuthHealth> {
  const out: Record<string, AuthHealth> = {};
  for (const [adapter, t] of Object.entries(DEFAULT_CONFIG.tiers)) {
    const models = [...Object.keys(t.models), ...(extra[adapter] ?? [])];
    out[adapter] = { installed: true, authed: true, models, modelAuth: Object.fromEntries(models.map((m) => [m, dead.includes(`${adapter}:${m}`)
      ? { authed: false, reason: "probe timed out (60000ms)", probedAt: "2026-11-10T00:00:00Z" } : { authed: true, probedAt: "2026-11-10T00:00:00Z" }])) };
  }
  return out;
}
/** What the screen is built from: the two config layers as text, the probe results, and where the layers are written. */
export const source = <C extends object = Record<string, never>>(over: Partial<FleetInputs> = {}, ctx: C = {} as C) =>
  ({ inputs: { userText: "", repoText: "", health: health(), adapters, now: NOW, ...over } as FleetInputs, ctx, paths: { user: "/u/config.yaml", repo: "/r/.tickmarkr/config.yaml" } });
export const POOL = `routing:
  mode: partner-led
  map:
    implement:
      tier: null
      pool:
        mode: any
        channels:
          # the frontier worker
          - codex:gpt-6-astra
          - codex:gpt-5.6-terra
`;
