#!/bin/sh

set -u

output_file=${1-}
if [ "$#" -ne 1 ] || [ ! -r "$output_file" ]; then
  printf '%s\n' "COUNT_ORACLE RED expected=UNREADABLE actual=UNREADABLE"
  exit 1
fi

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

if actual=$(awk '
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
  :
else
  printf '%s\n' "COUNT_ORACLE RED expected=$expected actual=UNREADABLE"
  exit 1
fi

if [ "$actual" -eq "$expected" ]; then
  printf '%s\n' "COUNT_ORACLE GREEN expected=$expected actual=$actual"
  exit 0
fi

printf '%s\n' "COUNT_ORACLE RED expected=$expected actual=$actual"
exit 1
