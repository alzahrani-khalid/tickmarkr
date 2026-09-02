#!/bin/sh

set -u

# Usage: assert-test-file-count.sh <vitest-output-log>... — one log per invocation; every log must
# carry exactly one "Test Files ... (N)" summary; the N values are SUMMED and compared with the
# tracked test-file count. OBS-829: the full suite runs as two invocations (the parallel `suite`
# project under coverage, the three single-fork projects plain) so a worker rpc timeout in the first
# cannot silently drop the second's files — the oracle therefore reads both logs.
if [ "$#" -lt 1 ]; then
  printf '%s\n' "COUNT_ORACLE RED expected=UNREADABLE actual=UNREADABLE"
  exit 1
fi
for output_file in "$@"; do
  if [ ! -r "$output_file" ]; then
    printf '%s\n' "COUNT_ORACLE RED expected=UNREADABLE actual=UNREADABLE"
    exit 1
  fi
done

repo_root=$(git rev-parse --show-toplevel) || {
  printf '%s\n' "COUNT_ORACLE RED expected=UNREADABLE actual=UNREADABLE"
  exit 1
}

expected_file=$(mktemp "${TMPDIR:-/tmp}/tickmarkr-test-files.XXXXXX") || {
  printf '%s\n' "COUNT_ORACLE RED expected=UNREADABLE actual=UNREADABLE"
  exit 1
}
trap 'rm -f "$expected_file"' EXIT HUP INT TERM

if ! git -C "$repo_root" ls-files 'tests/*.test.ts' > "$expected_file"; then
  printf '%s\n' "COUNT_ORACLE RED expected=UNREADABLE actual=UNREADABLE"
  exit 1
fi
expected=$(awk 'END { print NR }' "$expected_file")

actual=0
for output_file in "$@"; do
if value=$(awk '
  {
    line = $0
    escape = sprintf("%c", 27)
    gsub(escape "\\[[0-9;]*m", "", line)
    if (line ~ /^[[:space:]]*Test Files[[:space:]]/ && match(line, /\([0-9]+\)[[:space:]]*$/)) {
      value = substr(line, RSTART + 1, RLENGTH - 1)
      sub(/\)[[:space:]]*$/, "", value)
      matches++
    }
  }
  END {
    if (matches == 1) {
      print value
    } else {
      exit 1
    }
  }
' "$output_file"); then
  actual=$((actual + value))
else
  printf '%s\n' "COUNT_ORACLE RED expected=$expected actual=UNREADABLE"
  exit 1
fi
done

if [ "$actual" -eq "$expected" ]; then
  printf '%s\n' "COUNT_ORACLE GREEN expected=$expected actual=$actual"
  exit 0
fi

printf '%s\n' "COUNT_ORACLE RED expected=$expected actual=$actual"
exit 1
