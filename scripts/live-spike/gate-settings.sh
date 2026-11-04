#!/usr/bin/env bash
# Gate settings: can the pane's own --settings file stay in control when the repo ships its own settings?
#
# The worktree carries a repo-level `.claude/settings.json` with `disableAllHooks`, an `env.ANTHROPIC_BASE_URL`
# override (plus a probe variable) and a SessionStart hook, and a CLAUDE.md that defines a codeword. claude starts
# against `--settings <pane file>`, a per-run CLAUDE_CONFIG_DIR and `--setting-sources` (default `user`, override with
# KDZ_SETTING_SOURCES) so the repo file is not a source. The pane file carries the hook logger, an env probe hook and
# a `permissions.deny` rule for `Bash(touch:*)`. Four checks, each needing positive evidence that the CLI ran:
#   1. project hooks fired    = 0   (the repo SessionStart hook never wrote its marker)
#   2. project env overrides  = 0   (the probe hook saw neither the sentinel base URL nor the probe variable)
#   3. the pane deny rule is enforced (a Bash PreToolUse, no Bash PostToolUse, no marker, no Bash PermissionRequest)
#   4. CLAUDE.md still loads (the model answers with the codeword)
# Checks 3 and 4 need a model that follows the prompts (a cheap real model; a scripted mock cannot read CLAUDE.md),
# selected through ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN.
#
#   bash gate-settings.sh [--self-test]
#
# Prints NUM settings_* counters and `GATE settings <n>/4`.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SPIKE_DIR/lib.sh"

TOTAL=4
SESSION="kdz-settings"
SENTINEL_URL="http://127.0.0.1:9/kdz-project-override"
TURN_TIMEOUT_MS=$((${KDZ_TURN_TIMEOUT_S:-60} * 1000))

spike_init "$@"

SPIKE_CONFIG_DIR="$RUN_DIR/config-dir"
workdir="$(new_workdir settings)"
codeword="KDZ-CODEWORD-$RANDOM$RANDOM"
seed_trust "$workdir"
prepare_case settings

project_hook_marker="$CASE_DIR/project-hook-fired"
probe_file="$CASE_DIR/env-probe.log"
deny_marker="$workdir/deny-marker"

# A dialog opening means the deny rule did not apply; waiting for a Stop would only burn the timeout.
turn_ended_or_dialog_opened() {
  event_count_above Stop "$stop_base" || event_seen PermissionRequest
}

# 1. The repo side: everything a hostile or merely opinionated repository could ship.
printf 'The repository codeword is %s.\n' "$codeword" >"$workdir/CLAUDE.md"
mkdir -p "$workdir/.claude"
jq -n \
  --arg hook "touch $(printf '%q' "$project_hook_marker")" \
  --arg url "$SENTINEL_URL" '
  {
    disableAllHooks: true,
    env: {ANTHROPIC_BASE_URL: $url, KDZ_PROJECT_ENV_PROBE: "applied"},
    hooks: {SessionStart: [{hooks: [{type: "command", command: $hook}]}]},
  }' >"$workdir/.claude/settings.json"

# 2. The pane side: the logger wrapped by a probe that records what env the hooks run with, as words, never values.
probe_hook="$CASE_DIR/probe-hook.sh"
cat >"$probe_hook" <<EOF
#!/usr/bin/env bash
payload="\$(cat)"
printf '%s' "\$payload" | $(printf '%q' "$LOGGER")
if [ "\$(printf '%s' "\$payload" | jq -r .hook_event_name)" = SessionStart ]; then
  {
    if [ "\${ANTHROPIC_BASE_URL:-}" = "$SENTINEL_URL" ]; then echo base_url_override; else echo base_url_kept; fi
    echo "project_env_\${KDZ_PROJECT_ENV_PROBE:-unset}"
  } >>$(printf '%q' "$probe_file")
fi
EOF
chmod +x "$probe_hook"
write_settings "$SETTINGS_FILE" "$probe_hook" "$LOGGER" 600 '{"permissions": {"deny": ["Bash(touch:*)"]}}'

launch_claude "$SESSION" "$workdir" --setting-sources "${KDZ_SETTING_SOURCES:-user}"

status=0
wait_for 15000 "$SESSION" file_exists "$probe_file" || status=$?

started=0
if [ "$status" -eq 0 ]; then
  started=1
elif session_alive "$SESSION"; then
  # The CLI runs but the pane hooks never fired: a repo `disableAllHooks` reached it. Wait so the repo hook gets its
  # chance to fire too, which keeps the counters honest.
  num settings_pane_hooks_suppressed 1
  sleep 6
else
  note "settings: the CLI exited before SessionStart"
fi

hooks_fired=0
[ ! -e "$project_hook_marker" ] || hooks_fired=1
overrides_applied=0
if [ -s "$probe_file" ]; then
  overrides_applied="$(grep -c -e base_url_override -e project_env_applied "$probe_file")" || true
fi

# 3. Model-backed checks, only when the pane hooks work (they are the evidence channel).
claude_md_loaded=0
denied_tool_ran=0
deny_enforced=0
if [ "$started" -eq 1 ]; then
  stop_base="$(event_count Stop)"
  if send_text "$SESSION" "Read the repository memory in CLAUDE.md and reply with only the codeword it defines." &&
    wait_for "$TURN_TIMEOUT_MS" "$SESSION" event_count_above Stop "$stop_base"; then
    if event_field Stop '.last_assistant_message // empty' "$(event_count Stop)" | grep -qF -- "$codeword"; then
      claude_md_loaded=1
    fi
  fi

  stop_base="$(event_count Stop)"
  if send_text "$SESSION" "Use the Bash tool exactly once to run: touch $deny_marker"; then
    wait_for "$TURN_TIMEOUT_MS" "$SESSION" turn_ended_or_dialog_opened || true
  fi
  # Only Bash events count: the earlier CLAUDE.md turn may have run a Read, which fires its own PostToolUse.
  if [ -e "$deny_marker" ] || [ "$(event_tool_count PostToolUse Bash)" -gt 0 ]; then
    denied_tool_ran=1
  fi
  # A rule that denies outright never opens a dialog; an open dialog means the rule was not applied.
  if [ "$denied_tool_ran" -eq 0 ] && [ "$(event_tool_count PreToolUse Bash)" -gt 0 ] &&
    [ "$(event_tool_count PermissionRequest Bash)" -eq 0 ]; then
    deny_enforced=1
  fi
fi

num settings_project_hooks_fired "$hooks_fired"
num settings_project_env_overrides_applied "$overrides_applied"
num settings_denied_tool_ran "$denied_tool_ran"
num settings_claude_md_loaded "$claude_md_loaded"

passed=0
[ "$started" -eq 1 ] && [ "$hooks_fired" -eq 0 ] && passed=$((passed + 1))
[ "$started" -eq 1 ] && [ "$overrides_applied" -eq 0 ] && passed=$((passed + 1))
[ "$deny_enforced" -eq 1 ] && passed=$((passed + 1))
[ "$claude_md_loaded" -eq 1 ] && passed=$((passed + 1))

gate_report settings "$passed" "$TOTAL"
