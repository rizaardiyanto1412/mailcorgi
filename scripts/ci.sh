#!/bin/sh
# Local CI: everything a merge needs, in order. There is no hosted CI by decision.
set -eu
cd "$(dirname "$0")/.."
run() {
  printf '\n\033[1m== %s ==\033[0m\n' "$1"
  shift
  "$@"
}
run "typecheck" npm run typecheck
run "lint" npm run lint
run "test" npm test
run "build" npm run build
run "smoke" npm run smoke
printf '\n\033[32mci: all green\033[0m\n'
