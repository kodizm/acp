#!/usr/bin/env bash
# Gate launch: does an interactive claude reach SessionStart reliably and fast?
#
# 20 launches, each in a fresh git worktree with the trust entry pre-seeded by realpath. A launch passes when the
# SessionStart hook is logged less than 5 s after the tmux session was started. Needs no model call.
#
#   bash gate-launch.sh [--self-test]
#
# Prints NUM sessionstart_ms_p95 and `GATE launch <passed>/20`. See lib.sh for the env contract.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SPIKE_DIR/lib.sh"

TOTAL=20
LIMIT_MS=5000
SESSION="kdz-launch"

spike_init "$@"

# 1. Trust is keyed by realpath and must exist before the first launch, or the trust dialog withholds the hooks.
workdirs=()
for ((i = 1; i <= TOTAL; i++)); do
  workdirs+=("$(new_workdir "launch-$i")")
done
seed_trust "${workdirs[@]}"

# 2. One server per launch, so every run starts from the same cold state.
passed=0
for ((i = 1; i <= TOTAL; i++)); do
  prepare_case "launch-$i"
  started_at="$(now_ms)"
  launch_claude "$SESSION" "${workdirs[$((i - 1))]}"

  status=0
  wait_for $((LIMIT_MS + 3000)) "$SESSION" event_seen SessionStart || status=$?

  if [ "$status" -eq 0 ]; then
    elapsed=$(($(event_ts SessionStart) - started_at))
    sample sessionstart_ms "$elapsed"
    if [ "$elapsed" -lt "$LIMIT_MS" ]; then
      passed=$((passed + 1))
    else
      note "launch $i: SessionStart after ${elapsed} ms"
    fi
  else
    note "launch $i: no SessionStart (wait status $status)"
  fi

  kill_server
done

num_p95 sessionstart_ms
gate_report launch "$passed" "$TOTAL"
