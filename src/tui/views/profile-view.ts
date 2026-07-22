import { channelKey } from "../../adapters/types.js";
import { loadConfig, type TickmarkrConfig } from "../../config/config.js";
import {
  AVAIL_WEIGHT,
  cellsOf,
  cellSummary,
  EXPLORE_CAP,
  HALF_LIFE_RUNS,
  learnedScore,
  MIN_SAMPLES,
  type RoutingProfile,
} from "../../route/profile.js";
import { loadRoutingProfile } from "../../run/journal.js";
import type { View } from "../app.js";

// v1.66 T6: the Profile tab — the learned-routing inspector. Renders the profile the router
// loads (loadRoutingProfile — the ONE shared builder, never a parallel readAllTelemetry path),
// per shape×channel: learned score, sample counts, decay state, and exploration status, with
// the half-life / availability weight / exploration cap in effect, and names every configured
// pin that overrode a higher-scored learned channel (route() returns a map pin BEFORE the
// learned sort — router.ts:223-230 — so a warm rival outscoring the pin is an override).
// Read-only: renders, never derives — cellSummary/learnedScore are the arithmetic sources.

export type ProfileViewData = {
  cfg: TickmarkrConfig;
  /** the loaded routing profile; undefined ⇒ cold (no telemetry in the window) */
  profile?: RoutingProfile;
};

export type ProfileViewDeps = {
  /** injected fixture data — with data present the render path never touches the filesystem */
  data?: ProfileViewData;
  /** where the no-arg studio shell loads config and the profile from (default: process.cwd()) */
  repoRoot?: string;
};

const fmtSigned = (n: number) => (n >= 0 ? `+${n.toFixed(3)}` : n.toFixed(3));

// No-arg shell path (app.ts constructs views without deps): the SAME loader the daemon's router
// calls (daemon.ts:194), with the profile command's inspection-surface preview flag so the tab
// still renders under routing.learned:off — labeled inert in the header, as `tickmarkr profile`
// does. Best-effort: a load failure degrades to an explanatory note instead of breaking the studio.
function loadDefaultData(repoRoot: string): ProfileViewData | null {
  try {
    const cfg = loadConfig(repoRoot);
    return { cfg, profile: loadRoutingProfile(repoRoot, cfg, { preview: true }) };
  } catch {
    return null;
  }
}

// A configured pin that beat a higher-scored learned channel, or null. route() consults the map
// pin before any learned sorting, so when another channel's learned score for the shape tops the
// pin's, the pin is overriding learned evidence — the case this inspector exists to name.
function pinOverride(
  profile: RoutingProfile,
  cfg: TickmarkrConfig,
  shape: string,
  pin: { via: string; model: string },
  scoreOpts: { availWeight?: number },
): string | null {
  const pinChKey = channelKey({ adapter: pin.via, model: pin.model });
  const pinChannel = cfg.tiers[pin.via]?.channel ?? "sub";
  const pinScore = learnedScore(profile, shape, pinChKey, pinChannel, scoreOpts);
  let top: { chKey: string; channel: string; score: number } | null = null;
  for (const { shape: s, chKey, channel } of cellsOf(profile)) {
    if (s !== shape || (chKey === pinChKey && channel === pinChannel)) continue;
    const score = learnedScore(profile, shape, chKey, channel, scoreOpts);
    if (score > pinScore && (!top || score > top.score)) top = { chKey, channel, score };
  }
  if (!top) return null;
  return `${shape}: pin ${pinChKey} (score ${fmtSigned(pinScore)}) overrides higher-scored ${top.chKey} (${top.channel}, score ${fmtSigned(top.score)})`;
}

export function createProfileView(deps: ProfileViewDeps = {}): View {
  const data = deps.data ?? loadDefaultData(deps.repoRoot ?? process.cwd());

  return {
    id: "profile",
    label: "Profile",
    render: (): string[] => {
      const lines: string[] = ["Profile view — learned-routing inspector (read-only)"];
      if (!data) {
        lines.push("profile data unavailable — see `tickmarkr profile` for the line-mode surface");
        return lines;
      }
      const { cfg, profile } = data;
      const halfLife = cfg.routing.learnedTuning?.halfLifeRuns ?? HALF_LIFE_RUNS;
      const availWeight = cfg.routing.learnedTuning?.availWeight ?? AVAIL_WEIGHT;
      // router.ts:29's exploreCap — the exploration fence in effect, not the bare module default
      const cap = cfg.routing.explore?.cap ?? EXPLORE_CAP;
      lines.push(
        `routing.learned: ${cfg.routing.learned}${cfg.routing.learned === "off" ? " (preview — routing is inert)" : ""}`,
      );
      lines.push(`half-life: ${halfLife} runs   availability weight: ${availWeight}   exploration cap: ${cap}`);

      if (!profile || profile.cells.size === 0) {
        // ROUTE-07's cold start, explained: an empty profile scores every channel exactly NEUTRAL,
        // so routing is byte-identical static routing until real samples accumulate.
        lines.push(
          "cold start — no learned evidence yet:",
          `  every channel scores exactly neutral and routing follows the static policy`,
          `  until a shape×channel cell accumulates ${MIN_SAMPLES} samples.`,
        );
        return lines;
      }

      const scoreOpts = { availWeight: cfg.routing.learnedTuning?.availWeight };
      lines.push(
        `  ${"shape".padEnd(10)} ${"channel".padEnd(28)} ${"class".padEnd(5)} ${"score".padEnd(8)} samples           decay     explore`,
      );
      for (const { shape, chKey, channel, cell } of cellsOf(profile)) {
        const s = cellSummary(cell);
        const score = learnedScore(profile, shape, chKey, channel, scoreOpts);
        // decayed ⇔ rank-decay folded older runs below full weight (n_eff < n_raw); fresh ⇔ all
        // evidence at weight 1. The two states must never render alike.
        const decay = s.nEff < s.nRaw ? "decayed" : "fresh";
        const remaining = Math.max(0, cap - cell.dispatches);
        const explore = remaining > 0 ? `left ${remaining}` : "spent";
        const disc = s.discounted > 0 ? `  disc=${s.discounted}` : "";
        const cold = s.cold ? `  cold (n<${MIN_SAMPLES})` : "";
        lines.push(
          `  ${shape.padEnd(10)} ${chKey.padEnd(28)} ${channel.padEnd(5)} ${fmtSigned(score).padEnd(8)} ${`n_eff=${s.nEff} n_raw=${s.nRaw}`.padEnd(18)} ${decay.padEnd(9)} ${explore}${disc}${cold}`,
        );
      }

      const overrides: string[] = [];
      for (const [shape, entry] of Object.entries(cfg.routing.map).sort(([a], [b]) => a.localeCompare(b))) {
        if (!entry.pin) continue;
        const named = pinOverride(profile, cfg, shape, entry.pin, scoreOpts);
        if (named) overrides.push(named);
      }
      if (overrides.length) {
        lines.push("pins overriding higher-scored learned channels:", ...overrides.map((l) => `  ${l}`));
      } else if (Object.values(cfg.routing.map).some((e) => e?.pin)) {
        lines.push("pins: none overrides a higher-scored learned channel");
      }
      return lines;
    },
  };
}
