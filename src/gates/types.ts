export interface GateResult {
  gate: string;
  pass: boolean;
  details: string;
  meta?: Record<string, unknown>; // v1.1: machine-readable extras (e.g. review's reviewer channel for failover)
}
