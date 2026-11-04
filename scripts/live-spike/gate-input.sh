#!/usr/bin/env bash
# Gate input: does text pasted into the pane arrive as the sanitiser says, and does the delivery guard keep a prompt
# out of an open permission dialog?
#
# Raw pass (`NUM input_raw_<kind>`): the raw bytes of seven awkward kinds are pasted once each and Enter is sent
# (`load-buffer -b <name> -` then `paste-buffer -p -d -r -S`: tmux keeps LF instead of turning it into CR, and keeps
# control bytes instead of rewriting ESC as `^[`). 1 means the transcript user record equals the raw payload byte for
# byte. CLI 2.1.280 keeps plain text exactly and fails ESC, the paste-end sequence ESC[201~, U+009B, 0x03, a leading
# `/` (slash command) and tab (rewritten), which is why the pane never receives raw bytes. The tab form the TUI keeps
# is measured here (`NUM input_tab_handling`) and becomes the sanitiser's tab mapping.
#
# Part 1 (`GATE input`): 50 payloads cycling through those kinds, plus two of 52000 chars. Each goes through
# sanitize_payload (lib.sh, the rule Step 3 implements in TypeScript) first. A payload passes when the transcript user
# record equals the sanitised text byte for byte; a rejected payload (first non-blank character `!` or `/`) passes
# when nothing was sent, i.e. no new UserPromptSubmit.
#
# Part 2 (`GATE dialog`): 20 times a tool call opens a permission dialog held by a hook that waits for an answer file
# (the orchestrator-side answer path). A prompt is then offered to deliver_prompt (lib.sh), whose guard refuses while
# the dialog is open. A run passes when the guard refused, no dialog was answered and the tool stayed unrun; the
# dialog is then resolved through the hook so the next run starts clean. Pasting a prompt plus Enter into an open
# dialog answers it (Enter takes the default), so `NUM dialog_raw_answered <n>/5` repeats it with the guard off in
# its own session with a non-blocking hook; 5/5 is the expected figure.
#
# Parts 1 and the raw pass send plain prompts; part 2 needs a model that calls the Bash tool when asked (a scripted
# local mock endpoint or a cheap real model, selected through ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN).
#   KDZ_INPUT_TOTAL       payloads in part 1 (default 50)
#   KDZ_DIALOG_TOTAL      guarded dialog runs (default 20)
#   KDZ_DIALOG_RAW_TOTAL  guard-off dialog runs (default 5)
#
#   bash gate-input.sh [--self-test]
#
# Prints NUM paste_enter_delay_ms_p95, NUM input_raw_*, NUM input_tab_handling, `GATE input <n>/50`,
# `GATE dialog <n>/20` and NUM dialog_raw_answered.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SPIKE_DIR/lib.sh"

INPUT_TOTAL="${KDZ_INPUT_TOTAL:-50}"
DIALOG_TOTAL="${KDZ_DIALOG_TOTAL:-20}"
DIALOG_RAW_TOTAL="${KDZ_DIALOG_RAW_TOTAL:-5}"
SESSION="kdz-input"
TURN_TIMEOUT_MS=$((${KDZ_TURN_TIMEOUT_S:-60} * 1000))
RAW_KINDS="esc:0 esc201:1 c1:2 c0:3 leadingspacebang:4 slash:5 tab:11"

spike_init "$@"

fill() { # chars
  perl -e 'print substr("abcdefghij" x (int($ARGV[0] / 10) + 1), 0, $ARGV[0])' "$1"
}

# Kind 0 to 13 of the payload cycle, each tagged so a transcript match can only be the payload itself.
write_kind_payload() { # kind tag file
  local tag="$2" file="$3"

  case "$1" in
    0) printf '%s before\x1bafter' "$tag" >"$file" ;;
    1) printf '%s a\x1b[201~b still inside the paste' "$tag" >"$file" ;;
    2) printf '%s a\xc2\x9bb' "$tag" >"$file" ;;
    3) printf '%s a\x03b' "$tag" >"$file" ;;
    4) printf ' !%s echo not-a-shell' "$tag" >"$file" ;;
    5) printf '/%s slash first, literal' "$tag" >"$file" ;;
    6) printf '%s C-c C-d Escape Enter literal key names' "$tag" >"$file" ;;
    7) printf '%s line one\nline two\n\nline four' "$tag" >"$file" ;;
    8) printf '%s caf\xc3\xa9 \xc3\xa7\xc4\x9f\xc4\xb1 \xe6\x97\xa5\xe6\x9c\xac \xf0\x9f\x98\x80' "$tag" >"$file" ;;
    9) printf '%s ends with a semicolon;' "$tag" >"$file" ;;
    10) printf '%s %s' "$tag" "\"dq\" 'sq' \`bt\` \$HOME \\ ~ @mention" >"$file" ;;
    11) printf '%s\ttab\tseparated' "$tag" >"$file" ;;
    12) { printf '%s ' "$tag"; fill 4900; } >"$file" ;;
    13) printf '%s ends with a bang!' "$tag" >"$file" ;;
  esac
}

# Payload 1 and 2 are the 52000-char cases; the rest cycle through the awkward-byte kinds.
write_payload() { # index file
  local index="$1" file="$2" tag="kdz-input-$1"

  case "$index" in
    1) { printf '%s ' "$tag"; fill $((52000 - ${#tag} - 1)); } >"$file" ;;
    2) perl -e '
         my $text = "$ARGV[0] ";
         $text .= substr("abcdefghij" x 10, 0, 99) . "\n" while length($text) < 51_900;
         print substr($text . ("z" x 100), 0, 52000);' "$tag" >"$file" ;;
    *) write_kind_payload $(((index - 3) % 14)) "$tag" "$file" ;;
  esac
}

# start_session label [file]: `file` swaps the logging PermissionRequest hook for one that waits for an answer file.
start_session() {
  local workdir
  workdir="$(new_workdir "$1")"
  seed_trust "$workdir"
  prepare_case "$1"

  if [ "${2:-}" = file ]; then
    ANSWER_FILE="$CASE_DIR/permission-answer"
    write_permission_hook "$CASE_DIR/permission-hook.sh" "$LOGGER" file "$ANSWER_FILE"
    write_settings "$SETTINGS_FILE" "$LOGGER" "$CASE_DIR/permission-hook.sh" 600
  fi

  launch_claude "$SESSION" "$workdir"
  wait_for 15000 "$SESSION" event_seen SessionStart
}

# Reads the transcript path of the SessionStart that start_session waited for.
load_transcript() { # label
  TRANSCRIPT="$(event_field SessionStart '.transcript_path // empty')"
  [ -n "$TRANSCRIPT" ] || { note "$1: SessionStart carried no transcript_path"; return 1; }
}

# Derives the tab form the TUI kept from the raw tab payload's record, and makes the sanitiser map tab to it.
measure_tab_handling() { # tag
  local text rest middle token

  text="$(transcript_last_user_text "$TRANSCRIPT")"
  case "$text" in
    "$1"*) ;;
    *) num input_tab_handling unknown; return 0 ;;
  esac
  rest="${text#"$1"}"
  middle="${rest%%tab*}"

  if [ "$middle" = $'\t' ]; then
    token=kept
  elif [ -z "$middle" ]; then
    token=dropped
  elif [ -z "${middle// /}" ]; then
    token="spaces${#middle}"
  else
    token=other
  fi
  SANITIZE_TAB="$middle"
  num input_tab_handling "$token"
}

# 0. Raw behaviour: each kind sent once, byte for byte. Does not count toward the 50.
run_raw_part() {
  local pair kind name tag value stop_base status=0

  start_session raw || status=$?
  if [ "$status" -ne 0 ] || ! load_transcript raw; then
    note "raw: no usable session (wait status $status)"
    for pair in $RAW_KINDS; do
      num "input_raw_${pair%%:*}" na
    done
    num input_tab_handling na
    return 1
  fi

  for pair in $RAW_KINDS; do
    name="${pair%%:*}"
    kind="${pair##*:}"
    tag="kdz-raw-$name"
    value=0
    session_alive "$SESSION" || { note "raw: session died before $name"; num "input_raw_$name" na; continue; }
    write_kind_payload "$kind" "$tag" "$CASE_DIR/payload.txt"
    stop_base="$(event_count Stop)"

    if send_prompt "$SESSION" "$CASE_DIR/payload.txt"; then
      wait_for "$TURN_TIMEOUT_MS" "$SESSION" event_count_above Stop "$stop_base" || true
      if transcript_has_prompt "$TRANSCRIPT" "$CASE_DIR/payload.txt"; then
        value=1
      fi
      if [ "$name" = tab ]; then
        measure_tab_handling "$tag"
      fi
    else
      press "$SESSION" C-u || true
      if [ "$name" = tab ]; then
        num input_tab_handling unknown
      fi
    fi
    num "input_raw_$name" "$value"
  done
}

# 1. The sanitised payload arrives byte-exact, a rejected one is never sent. The turn is awaited before the next
#    payload so a queued prompt cannot blur the match.
run_input_part() {
  local index passed=0 turn_timeouts=0 stop_base submit_base status=0 sanitize_status

  start_session input || status=$?
  if [ "$status" -ne 0 ]; then
    note "input: no SessionStart (wait status $status)"
    num input_turn_timeouts na
    return 1
  fi
  load_transcript input || return 1

  for ((index = 1; index <= INPUT_TOTAL; index++)); do
    session_alive "$SESSION" || { note "input: session died before payload $index"; break; }
    write_payload "$index" "$CASE_DIR/raw.txt"
    sanitize_status=0
    sanitize_payload "$CASE_DIR/raw.txt" "$CASE_DIR/payload.txt" || sanitize_status=$?
    stop_base="$(event_count Stop)"
    submit_base="$(event_count UserPromptSubmit)"

    if [ "$sanitize_status" -eq 3 ]; then
      sleep 0.5
      if [ "$(event_count UserPromptSubmit)" -eq "$submit_base" ]; then
        passed=$((passed + 1))
      else
        note "input: rejected payload $index reached the prompt"
      fi
      continue
    fi

    if [ "$sanitize_status" -eq 0 ] && send_prompt "$SESSION" "$CASE_DIR/payload.txt" &&
      wait_for 5000 "$SESSION" transcript_has_prompt "$TRANSCRIPT" "$CASE_DIR/payload.txt"; then
      passed=$((passed + 1))
    else
      note "input: payload $index not submitted or not the sanitised text"
      press "$SESSION" C-u || true
    fi

    wait_for "$TURN_TIMEOUT_MS" "$SESSION" event_count_above Stop "$stop_base" ||
      turn_timeouts=$((turn_timeouts + 1))
  done

  num input_turn_timeouts "$turn_timeouts"
  INPUT_PASSED="$passed"
}

deliver_text() { # session text
  printf '%s' "$2" >"$CASE_DIR/prompt.txt"
  deliver_prompt "$1" "$CASE_DIR/prompt.txt"
}

# 2. A prompt offered while a dialog is open must be refused by the guard. The tool writes a marker file, so
#    "answered" is the marker existing or a PostToolUse event arriving.
run_dialog_part() {
  local index passed=0 permission_base post_base stop_base marker refused status=0

  start_session dialog file || status=$?
  if [ "$status" -ne 0 ]; then
    note "dialog: no SessionStart (wait status $status)"
    return 1
  fi

  for ((index = 1; index <= DIALOG_TOTAL; index++)); do
    session_alive "$SESSION" || { note "dialog: session died before prompt $index"; break; }
    marker="$CASE_DIR/dialog-$index.marker"
    permission_base="$(event_count PermissionRequest)"
    post_base="$(event_count PostToolUse)"
    stop_base="$(event_count Stop)"

    if ! deliver_text "$SESSION" "Use the Bash tool exactly once to run: touch $marker"; then
      note "dialog: tool prompt $index not submitted"
      continue
    fi
    if ! wait_for "$TURN_TIMEOUT_MS" "$SESSION" event_count_above PermissionRequest "$permission_base"; then
      note "dialog: no dialog opened for prompt $index"
      press "$SESSION" Escape C-u || true
      continue
    fi

    printf '%s' "kdz-dialog-probe-$index" >"$CASE_DIR/probe.txt"
    refused=0
    deliver_prompt "$SESSION" "$CASE_DIR/probe.txt" || [ "$?" -ne 3 ] || refused=1
    sleep 1

    if [ "$refused" -eq 1 ] && dialog_open && [ ! -e "$marker" ] &&
      [ "$(event_count PostToolUse)" -eq "$post_base" ]; then
      passed=$((passed + 1))
    else
      note "dialog: run $index refused=$refused (guard must refuse, dialog stays open, tool stays unrun)"
    fi

    # Resolve through the hook so the next run starts with no dialog open.
    answer_permission "$ANSWER_FILE" allow
    wait_for 30000 "$SESSION" event_count_above PostToolUse "$post_base" || note "dialog: run $index not resolved"
    wait_for "$TURN_TIMEOUT_MS" "$SESSION" event_count_above Stop "$stop_base" || true
    press "$SESSION" C-u || true
  done

  DIALOG_PASSED="$passed"
}

# 3. The same offer with the guard off: Enter takes the dialog's default. Its own session keeps the non-blocking hook
#    away from the answer-file hook above.
run_dialog_raw_part() {
  local index answered=0 permission_base post_base stop_base marker status=0

  start_session dialograw || status=$?
  if [ "$status" -ne 0 ]; then
    note "dialog raw: no SessionStart (wait status $status)"
    return 1
  fi

  for ((index = 1; index <= DIALOG_RAW_TOTAL; index++)); do
    session_alive "$SESSION" || { note "dialog raw: session died before prompt $index"; break; }
    marker="$CASE_DIR/dialog-raw-$index.marker"
    permission_base="$(event_count PermissionRequest)"
    post_base="$(event_count PostToolUse)"
    stop_base="$(event_count Stop)"

    if ! send_text "$SESSION" "Use the Bash tool exactly once to run: touch $marker"; then
      note "dialog raw: tool prompt $index not submitted"
      continue
    fi
    if ! wait_for "$TURN_TIMEOUT_MS" "$SESSION" event_count_above PermissionRequest "$permission_base"; then
      note "dialog raw: no dialog opened for prompt $index"
      press "$SESSION" Escape C-u || true
      continue
    fi

    printf '%s' "kdz-dialog-probe-$index" >"$CASE_DIR/probe.txt"
    paste_text "$SESSION" "$CASE_DIR/probe.txt"
    sleep 0.3
    press "$SESSION" Enter
    sleep 3

    if [ -e "$marker" ] || event_count_above PostToolUse "$post_base"; then
      answered=$((answered + 1))
      wait_for "$TURN_TIMEOUT_MS" "$SESSION" event_count_above Stop "$stop_base" || true
    else
      press "$SESSION" Escape || true
      sleep 2
    fi
    press "$SESSION" C-u || true
  done

  DIALOG_RAW_ANSWERED="$answered"
}

INPUT_PASSED=0
DIALOG_PASSED=0
DIALOG_RAW_ANSWERED=na
ANSWER_FILE=""
TRANSCRIPT=""
status=0

run_raw_part || status=1
kill_server
run_input_part || status=1
kill_server
run_dialog_part || status=1
kill_server
run_dialog_raw_part || status=1
kill_server

if [ "$DIALOG_RAW_ANSWERED" = na ]; then
  num dialog_raw_answered na
else
  num dialog_raw_answered "$DIALOG_RAW_ANSWERED/$DIALOG_RAW_TOTAL"
fi
num_p95 paste_enter_delay_ms
gate_report input "$INPUT_PASSED" "$INPUT_TOTAL" || status=1
gate_report dialog "$DIALOG_PASSED" "$DIALOG_TOTAL" || status=1
exit "$status"
