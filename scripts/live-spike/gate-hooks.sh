#!/usr/bin/env bash
# Gate hooks: can a command PermissionRequest hook answer a dialog, and what happens when it cannot?
#
# Six cases, each a fresh session whose model is asked to run `touch <marker>` through the Bash tool:
#   allow        the hook prints allow: the tool runs with no keystroke
#   deny         the hook prints deny: the tool never runs
#   hang         the hook sleeps past its 5 s timeout: dialog stays open, tool unrun, a human Enter still works
#   exit1        the hook exits 1: same
#   killed       the hook kills itself with SIGKILL: same
#   timeout3600  an allow hook declared with `timeout: 3600` is accepted (no settings error) and works
# Every case needs the PermissionRequest event to be logged, so a CLI that never starts cannot pass.
#
# Needs a model that calls the Bash tool when asked (a scripted local mock endpoint or a cheap real model,
# selected through ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN).
#
#   bash gate-hooks.sh [--self-test]
#
# Prints NUM hook_roundtrip_ms_p95 (PermissionRequest to PostToolUse in the allow cases) and `GATE hooks <n>/6`.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SPIKE_DIR/lib.sh"

TOTAL=6
SESSION="kdz-hooks"
MARKER=""

spike_init "$@"

# Starts a session whose PermissionRequest hook runs in the given mode and submits the tool prompt.
start_tool_case() { # label mode hook_timeout_s
  local label="$1" workdir

  workdir="$(new_workdir "$label")"
  seed_trust "$workdir"
  prepare_case "$label"
  write_permission_hook "$CASE_DIR/permission-hook.sh" "$LOGGER" "$2"
  write_settings "$SETTINGS_FILE" "$LOGGER" "$CASE_DIR/permission-hook.sh" "$3"
  MARKER="$workdir/hook-marker"

  launch_claude "$SESSION" "$workdir"
  wait_for 15000 "$SESSION" event_seen SessionStart || { note "$label: no SessionStart"; return 1; }
  send_text "$SESSION" "Use the Bash tool exactly once to run: touch $MARKER" || {
    note "$label: prompt not submitted"
    return 1
  }
}

record_roundtrip() {
  sample hook_roundtrip_ms "$(($(event_ts PostToolUse) - $(event_ts PermissionRequest)))"
}

case_allow() {
  start_tool_case allow allow 30 || return 1
  wait_for 60000 "$SESSION" file_exists "$MARKER" || { note "allow: tool did not run"; return 1; }
  wait_for 10000 "$SESSION" event_seen PostToolUse || { note "allow: no PostToolUse"; return 1; }
  event_seen PermissionRequest || return 1
  record_roundtrip
}

case_deny() {
  start_tool_case deny deny 30 || return 1
  wait_for 60000 "$SESSION" event_seen PermissionRequest || { note "deny: no PermissionRequest"; return 1; }
  # The model reports the denial, which ends the turn; without a Stop the check still waits a fixed grace period.
  wait_for 30000 "$SESSION" event_seen Stop || sleep 3
  session_alive "$SESSION" || return 1
  [ ! -e "$MARKER" ] || { note "deny: tool ran"; return 1; }
  [ "$(event_count PostToolUse)" -eq 0 ] || { note "deny: PostToolUse fired"; return 1; }
}

# The hook fails, hangs or dies: nobody answered, so the dialog must still be open and the tool unrun. A human Enter
# afterwards must still run the tool, which proves the dialog was alive rather than the turn silently dropped.
case_stays_open() { # label mode hook_timeout_s settle_s
  start_tool_case "$1" "$2" "$3" || return 1
  wait_for 60000 "$SESSION" event_seen PermissionRequest || { note "$1: no PermissionRequest"; return 1; }
  sleep "$4"
  session_alive "$SESSION" || { note "$1: session died"; return 1; }
  [ ! -e "$MARKER" ] || { note "$1: tool ran without an answer"; return 1; }
  [ "$(event_count Stop)" -eq 0 ] || { note "$1: turn ended without an answer"; return 1; }

  press "$SESSION" Enter
  wait_for 20000 "$SESSION" file_exists "$MARKER" || { note "$1: human Enter did not run the tool"; return 1; }
}

case_timeout_3600() {
  start_tool_case timeout3600 allow 3600 || return 1
  if spike_tmux capture-pane -p -t "$SESSION" | grep -Eqi 'settings error|invalid settings'; then
    note "timeout3600: the pane reports a settings error"
    return 1
  fi
  wait_for 60000 "$SESSION" file_exists "$MARKER" || { note "timeout3600: tool did not run"; return 1; }
  wait_for 10000 "$SESSION" event_seen PostToolUse || { note "timeout3600: no PostToolUse"; return 1; }
  record_roundtrip
}

passed=0
run_case() { # name function [args...]
  local name="$1"
  shift
  if "$@"; then
    passed=$((passed + 1))
    note "case $name: pass"
  else
    note "case $name: FAIL"
  fi
  kill_server
}

run_case allow case_allow
run_case deny case_deny
run_case hang case_stays_open hang hang 5 9
run_case exit1 case_stays_open exit1 exit1 30 4
run_case killed case_stays_open killed killed 30 4
run_case timeout3600 case_timeout_3600

num_p95 hook_roundtrip_ms
gate_report hooks "$passed" "$TOTAL"
