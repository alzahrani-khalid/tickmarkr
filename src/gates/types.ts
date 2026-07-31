// T11: meta.skipped === true means the gate DECLINED to run (e.g. review below its complexity
// threshold). pass stays true so enforcement is unchanged, but any summary of gate outcomes must
// report it as declined — never count it as a pass. The daemon journals it as `skipped: true`.
export interface GateResult {
  gate: string;
  pass: boolean;
  details: string;
  meta?: Record<string, unknown>; // v1.1: machine-readable extras (e.g. review's reviewer channel for failover)
}
