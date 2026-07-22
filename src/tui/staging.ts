import { fleetEditableEquals, type FleetEditable } from "../config/config.js";

/** One in-memory edit to the buffered fleet state. */
export type FleetEdit = (buffer: FleetEditable) => void;

/**
 * Staged-changes buffer for the Fleet Studio write path.
 *
 * - The loaded state is captured at construction and never mutated.
 * - Edits apply to an in-memory buffer only.
 * - `revert()` discards the buffer and restores the loaded state.
 * - The delta is computed through the existing `fleetEditableEquals` comparison.
 * - No code path in this module writes to disk.
 */
export class FleetStaging {
  private readonly loaded: FleetEditable;
  private buffer: FleetEditable;

  constructor(loaded: FleetEditable) {
    this.loaded = structuredClone(loaded);
    this.buffer = structuredClone(loaded);
  }

  /** Read-only snapshot of the originally loaded state. */
  get loadedState(): FleetEditable {
    return structuredClone(this.loaded);
  }

  /** Current buffered (possibly edited) state. */
  get current(): FleetEditable {
    return structuredClone(this.buffer);
  }

  /** Apply an edit to the buffer. Never touches disk. */
  apply(edit: FleetEdit): void {
    edit(this.buffer);
  }

  /** Discard all buffered edits and restore the loaded state. */
  revert(): void {
    this.buffer = structuredClone(this.loaded);
  }

  /** True when the buffer differs from the loaded state. */
  get isDirty(): boolean {
    return !fleetEditableEquals(this.loaded, this.buffer);
  }

  /** Number of distinct staged changes vs the loaded state. */
  get changeCount(): number {
    return fleetEditableDeltaCount(this.loaded, this.buffer);
  }
}

/** Count changed leaves using the same equality semantics as `fleetEditableEquals`. */
function fleetEditableDeltaCount(initial: FleetEditable, edited: FleetEditable): number {
  let count = 0;

  if (JSON.stringify(initial.denyAdapters) !== JSON.stringify(edited.denyAdapters)) {
    count += 1;
  }
  if (JSON.stringify(initial.denyModels) !== JSON.stringify(edited.denyModels)) {
    count += 1;
  }

  const mapKeys = new Set([...Object.keys(initial.map), ...Object.keys(edited.map)]);
  for (const shape of mapKeys) {
    if (JSON.stringify(initial.map[shape]) !== JSON.stringify(edited.map[shape])) {
      count += 1;
    }
  }

  const floorKeys = new Set([...Object.keys(initial.floors), ...Object.keys(edited.floors)]);
  for (const shape of floorKeys) {
    if (initial.floors[shape] !== edited.floors[shape]) {
      count += 1;
    }
  }

  const adapterKeys = new Set([...Object.keys(initial.tiers), ...Object.keys(edited.tiers)]);
  for (const adapter of adapterKeys) {
    const modelKeys = new Set([
      ...Object.keys(initial.tiers[adapter] ?? {}),
      ...Object.keys(edited.tiers[adapter] ?? {}),
    ]);
    for (const model of modelKeys) {
      if (
        JSON.stringify(initial.tiers[adapter]?.[model]) !==
        JSON.stringify(edited.tiers[adapter]?.[model])
      ) {
        count += 1;
      }
    }
  }

  return count;
}
