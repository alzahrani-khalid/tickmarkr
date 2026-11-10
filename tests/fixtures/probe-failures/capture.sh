#!/usr/bin/env bash
# Queue rows 353 and 367 (D-2187 condition 2): the capture instrument for the probe-failure fixtures
# beside it. Each cell runs an INSTALLED CLI and records its real stdout, stderr, exit code and elapsed
# milliseconds; nothing here is hand-typed. Cells reach no credentials (an empty CODEX_HOME under
# env -i, and an empty HOME for claude) except unknown-model, which sends one request naming a model the service does not serve.
# Usage: tests/fixtures/probe-failures/capture.sh <out-dir>
set -u
mkdir -p "$1"; out="$(cd "$1" && pwd)"
work="$(mktemp -d)"; empty="$(mktemp -d)"
printf 'Reply with OK\n' > "$work/prompt.txt"
git init -q "$work"  # production probes run from a repository root
codex_bin="$(command -v codex)"
claude_bin="$(command -v claude)"
cell() { # <name> <timeout-seconds> <command...>
  local name="$1" limit="$2"; shift 2
  local start end rc
  start=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
  perl -e 'alarm shift; exec @ARGV' "$limit" "$@" >"$out/$name.stdout" 2>"$out/$name.stderr"
  rc=$?
  end=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
  printf '%s\n' "$rc" > "$out/$name.rc"
  printf '%s\n' "$((end - start))" > "$out/$name.ms"
}
cd "$work" || exit 1
# launch fault: the 2.20.0 argv defect, --no-daemon placed after the exec subcommand.
cell launch-fault-argv 20 env -i HOME="$empty" CODEX_HOME="$empty" PATH="/usr/bin:/bin" "$codex_bin" exec --no-daemon --model gpt-6.1-sol - < "$work/prompt.txt"
# launch fault, second form: claude rejecting an option it does not know (exit 1, not 2).
cell launch-fault-argv-claude 20 env -i HOME="$empty" PATH="/usr/bin:/bin" "$claude_bin" -p --tickmarkr-no-such-flag "Reply with OK"
# timeout: the production argv with stdin held open and never closed; the alarm kills it.
cell timeout-stdin-held 8 env -i HOME="$empty" CODEX_HOME="$empty" PATH="/usr/bin:/bin" bash -c '(sleep 30) | "$0" --no-daemon exec --sandbox workspace-write --model gpt-6.1-sol -' "$codex_bin"
# signed out: the production argv under a home with no credentials at all.
cell signed-out-empty-home 60 env -i HOME="$empty" CODEX_HOME="$empty" PATH="/usr/bin:/bin" "$codex_bin" --no-daemon exec --sandbox workspace-write --model gpt-6.1-sol - < "$work/prompt.txt"
# model-turn fault: the operator's real signed-in codex, a model id the service does not serve.
cell unknown-model "60" "$codex_bin" --no-daemon exec --sandbox workspace-write --model tickmarkr-no-such-model - < "$work/prompt.txt"
"$codex_bin" --version > "$out/codex.version" 2>&1
"$claude_bin" --version > "$out/claude.version" 2>&1
date -u +%Y-%m-%dT%H:%M:%SZ > "$out/captured-at"
rm -rf "$work" "$empty"
