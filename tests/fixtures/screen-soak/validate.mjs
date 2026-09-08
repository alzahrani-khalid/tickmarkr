/** Pure duration-record validation, reusable in exported tests without private docs. */
export function validateSoak(record) {
  const errors = [];
  const rows = record.samples ?? [];
  const duration = 14400;
  if (!Number.isInteger(record.durationSeconds) || record.durationSeconds < 1 || record.durationSeconds > 86400 ||
      !Number.isFinite(record.elapsedMs) || !Array.isArray(rows)) {
    return { ok: false, errors: ['invalid duration or samples'], lateGrowth: null };
  }
  if (record.protocol !== 'C6-four-hour-production-v1') errors.push('wrong protocol');
  if (!/^[a-f0-9]{40}$/.test(record.sourceCommit ?? '')) errors.push('missing built source commit');
  if (record.environment?.NODE_ENV !== null) errors.push('ordinary entry environment required');
  if (record.sinkLimit !== 20000 || !record.writes || !record.bytes) errors.push('missing bounded render sink');
  if (!record.orderlyExit || record.failure) errors.push('UI failure or premature exit');
  if (record.durationSeconds < duration || record.elapsedMs < duration * 1000) errors.push('less than four hours');
  const wallDuration = Date.parse(record.endedAt) - Date.parse(record.startedAt);
  // Wall clocks can slew while the monotonic observation clock keeps advancing.
  // Corroborate within the existing two-interval tolerance; the final measured
  // monotonic endpoint below independently enforces the full four-hour duration.
  if (!Number.isFinite(wallDuration) || Math.abs(wallDuration - record.elapsedMs) > 120000) errors.push('wall-clock duration does not corroborate elapsed time');
  if (!record.resizeCount || !record.inputCount) errors.push('missing resize/input');
  if (rows[0]?.tick !== 0 || rows.at(-1)?.tick !== record.durationSeconds) errors.push('missing endpoints');
  const ticks = new Set(rows.map(row => row.tick));
  for (let tick = 0; tick <= record.durationSeconds; tick += 60) if (!ticks.has(tick)) errors.push('missing minute sample');
  if (!ticks.has(1000)) errors.push('missing warm-up endpoint');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], previous = rows[i - 1];
    if (row.pid !== record.pid || !Number.isInteger(row.tick) || !Number.isFinite(row.monotonicMs) ||
        !Number.isFinite(row.rss) || !Number.isFinite(row.heap) || !Number.isFinite(Date.parse(row.timestamp))) errors.push('invalid sample');
    if (row.tick >= 1000 && row.heap > 64 * 1048576) errors.push('retained heap exceeds 64 MiB');
    if (row.pendingOutputBytes > 20000) errors.push('unbounded output queue');
    if (previous && (row.tick <= previous.tick || row.monotonicMs <= previous.monotonicMs || Date.parse(row.timestamp) <= Date.parse(previous.timestamp))) errors.push('non-monotonic sample');
    if (previous && (row.tick - previous.tick > 60 || row.monotonicMs - previous.monotonicMs > 120000 || Date.parse(row.timestamp) - Date.parse(previous.timestamp) > 120000)) errors.push('missing or late minute sample');
    if (Math.abs(row.monotonicMs - row.tick * 1000) > 120000) errors.push('late observation');
  }
  const end = rows.find(row => row.tick === record.durationSeconds);
  if (!end || end.monotonicMs < duration * 1000) errors.push('less than four hours of measured observations');
  const lateStart = rows.find(row => row.tick === record.durationSeconds - 2000);
  if (!end || !lateStart) errors.push('missing final-2000 endpoints');
  if (!['HOME', 'RUN', 'EVIDENCE'].includes(end?.view) || end?.view !== lateStart?.view) errors.push('late-growth endpoints must show the same view');
  const lateGrowth = end && lateStart ? end.heap - lateStart.heap : null;
  if (lateGrowth !== null && lateGrowth > 16 * 1048576) errors.push('late growth exceeds 16 MiB');
  return { ok: errors.length === 0, errors: [...new Set(errors)], lateGrowth };
}
