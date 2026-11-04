#!/usr/bin/env bash
# Shared helpers for the live-spike gates. Sourced by gate-*.sh, never executed.
#
# A gate drives a real interactive `claude` in tmux and prints one `GATE <name> <passed>/<total>` line plus
# `NUM <name> <value>` lines for the parameters later steps consume. It only consumes env, and never prints,
# logs or writes a key or token:
#   CLAUDE_BIN            claude binary (default: `claude` on PATH)
#   ANTHROPIC_BASE_URL    model endpoint
#   ANTHROPIC_AUTH_TOKEN  its credential; it reaches the pane through the tmux server's inherited environment,
#                         so it never appears in an argument list
#   KDZ_TURN_TIMEOUT_S    how long a gate waits for a turn to end (default 60)
# Gates that need a deterministic reply or a tool call (dialog, hooks, esc, settings) can run against a scripted
# local mock endpoint or a cheap real model; both are selected through the two ANTHROPIC_* variables alone.
#
# `--self-test` swaps CLAUDE_BIN for /bin/false: the pane dies at once, so every gate must report 0 passes.
# Every check therefore needs positive evidence (a hook event, a transcript record); "nothing happened" never passes.
#
# Bash 3.2 compatible (macOS default): no associative arrays, no empty-array expansion under `set -u`.

SPIKE_SOCKET="kdz-spike"
SPIKE_SELF_TEST=0
SPIKE_CONFIG_DIR=""
RUN_DIR=""
RUN_HOME=""
CASE_DIR=""
EVENTS_FILE=""
LOGGER=""
SETTINGS_FILE=""

note() {
  printf 'spike: %s\n' "$*" >&2
}

spike_die() {
  note "$*"
  exit 2
}

spike_tmux() {
  tmux -L "$SPIKE_SOCKET" "$@"
}

spike_cleanup() {
  spike_tmux kill-server 2>/dev/null || true
  if [ -n "$RUN_DIR" ]; then
    rm -rf -- "$RUN_DIR"
  fi
}

# Parses --self-test, checks tools and env, and creates the run directory with its cleanup trap.
spike_init() {
  local arg tool var

  for arg in "$@"; do
    case "$arg" in
      --self-test) SPIKE_SELF_TEST=1 ;;
      *) spike_die "unknown argument: $arg" ;;
    esac
  done

  # macOS has no /bin/false, only /usr/bin/false.
  if [ "$SPIKE_SELF_TEST" = 1 ]; then
    CLAUDE_BIN=/bin/false
    [ -x "$CLAUDE_BIN" ] || CLAUDE_BIN=false
  fi

  for tool in tmux jq perl git; do
    command -v "$tool" >/dev/null || spike_die "missing tool: $tool"
  done

  CLAUDE_BIN="$(command -v "${CLAUDE_BIN:-claude}")" || spike_die "claude binary not found, set CLAUDE_BIN"

  if [ "$SPIKE_SELF_TEST" = 0 ]; then
    for var in ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN; do
      [ -n "${!var:-}" ] || spike_die "$var is not set"
    done
  fi

  RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kdz-spike.XXXXXX")"
  RUN_DIR="$(cd "$RUN_DIR" && pwd -P)"
  RUN_HOME="$RUN_DIR/home"
  mkdir -p "$RUN_HOME"

  trap spike_cleanup EXIT
  trap 'exit 130' INT TERM
}

now_ms() {
  perl -MTime::HiRes=time -e 'printf "%d\n", time() * 1000'
}

sleep_ms() {
  # LC_ALL=C: a decimal comma in the locale would make sleep reject the value.
  sleep "$(LC_ALL=C awk -v ms="$1" 'BEGIN { printf "%.3f", ms / 1000 }')"
}

session_alive() {
  spike_tmux has-session -t "$1" 2>/dev/null
}

# Polls a command until it succeeds. Returns 0 on success, 1 on timeout, 2 when the session died first.
wait_for() { # timeout_ms session command [args...]
  local timeout_ms="$1" session="$2" deadline
  shift 2
  deadline=$(($(now_ms) + timeout_ms))

  while :; do
    if "$@"; then
      return 0
    fi
    session_alive "$session" || return 2
    [ "$(now_ms)" -lt "$deadline" ] || return 1
    sleep 0.05
  done
}

file_exists() {
  [ -e "$1" ]
}

# A tmux server inherits the first client's environment, so killing it between cases is what makes the next
# launch pick up its own HOME and settings.
kill_server() {
  spike_tmux kill-server 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    spike_tmux ls >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  note "tmux server on socket $SPIKE_SOCKET did not exit"
}

# Creates a detached worktree off a throwaway repo. Prints its realpath: the trust entry is keyed by realpath,
# and /tmp resolves to /private/tmp on macOS.
new_workdir() { # label
  local repo="$RUN_DIR/repo" path="$RUN_DIR/wt/$1"

  if [ ! -d "$repo" ]; then
    git init -q "$repo"
    git -C "$repo" config user.name spike
    git -C "$repo" config user.email spike@example.invalid
    git -C "$repo" -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q --allow-empty -m spike
  fi

  mkdir -p "$RUN_DIR/wt"
  git -C "$repo" worktree add -q --detach "$path"
  (cd "$path" && pwd -P)
}

# Without these entries the trust dialog opens and withholds every hook. No API-key approval is seeded: the
# gates authenticate with ANTHROPIC_AUTH_TOKEN, and approving a key would mean writing part of it to disk.
seed_trust() { # realpath...
  local dir

  for dir in "$RUN_HOME" ${SPIKE_CONFIG_DIR:+"$SPIKE_CONFIG_DIR"}; do
    mkdir -p "$dir"
    jq -n '
      {
        hasCompletedOnboarding: true,
        theme: "dark",
        projects: (
          reduce $ARGS.positional[] as $path ({};
            .[$path] = {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: []}
          )
        ),
      }' --args "$@" >"$dir/.claude.json"
  done
}

# Appends "<epoch ms><TAB><one-line payload>" per hook event. The timestamp is taken before anything else runs.
write_hook_logger() { # script events_file
  cat >"$1" <<EOF
#!/usr/bin/env bash
ts="\$(perl -MTime::HiRes=time -e 'printf "%d", time() * 1000')"
payload="\$(cat)"
line="\$(printf '%s' "\$payload" | jq -c . 2>/dev/null)" || line="\$(printf '%s' "\$payload" | tr -d '\\n')"
printf '%s\\t%s\\n' "\$ts" "\$line" >>$(printf '%q' "$2")
EOF
  chmod +x "$1"
}

# The PermissionRequest hook output that answers a dialog: allow | deny.
permission_decision() { # behavior
  jq -nc --arg behavior "$1" '
    {hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: $behavior}}}
    | if $behavior == "deny" then .hookSpecificOutput.decision.message = "blocked by the kdz spike" else . end'
}

# A PermissionRequest hook that logs, then acts: log | allow | deny | hang | exit1 | killed | file. Mode `file` blocks
# until the answer file exists, then prints its content as the decision: the orchestrator-side answer path, driven by
# answer_permission. One hook polls a given answer file at a time, so a case using it must never answer a dialog by key.
write_permission_hook() { # script logger mode [answer_file]
  local script="$1" logger="$2" mode="$3" body

  case "$mode" in
    log) body=':' ;;
    allow | deny) body="printf '%s' $(printf '%q' "$(permission_decision "$mode")")" ;;
    hang) body='exec sleep 120' ;;
    exit1) body='exit 1' ;;
    killed) body='kill -9 $$' ;;
    file) body="$(printf 'while [ ! -s %q ]; do sleep 0.1; done\ncat %q\nrm -f %q' "$4" "$4" "$4")" ;;
    *) spike_die "unknown permission hook mode: $mode" ;;
  esac

  printf '#!/usr/bin/env bash\n%q\n%s\n' "$logger" "$body" >"$script"
  chmod +x "$script"
}

# Answers the dialog held by a `file` mode hook. The rename keeps the hook from reading a half-written file.
answer_permission() { # answer_file allow|deny
  permission_decision "$2" >"$1.tmp"
  mv -f -- "$1.tmp" "$1"
}

# Writes a --settings file: the logger on every event the gates read, and one PermissionRequest command.
write_settings() { # file logger permission_cmd permission_timeout_s [extra_json_object]
  local extra='{}'
  if [ "$#" -ge 5 ]; then
    extra="$5"
  fi

  jq -n \
    --arg log "$(printf '%q' "$2")" \
    --arg perm "$(printf '%q' "$3")" \
    --argjson timeout "$4" \
    --argjson extra "$extra" '
    {
      hooks: (
        reduce ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionDenied", "Stop") as $event
          ({}; .[$event] = [{hooks: [{type: "command", command: $log}]}])
        | .PermissionRequest = [{hooks: [{type: "command", command: $perm, timeout: $timeout}]}]
      ),
    } + $extra' >"$1"
}

# Per-case state: events log, logger script and a log-only settings file. Gates rewrite the settings when needed.
prepare_case() { # label
  CASE_DIR="$RUN_DIR/case-$1"
  mkdir -p "$CASE_DIR"
  EVENTS_FILE="$CASE_DIR/events.log"
  : >"$EVENTS_FILE"
  LOGGER="$CASE_DIR/log-hook.sh"
  SETTINGS_FILE="$CASE_DIR/settings.json"
  write_hook_logger "$LOGGER" "$EVENTS_FILE"
  write_settings "$SETTINGS_FILE" "$LOGGER" "$LOGGER" 600
}

# Starts claude in a new detached session with CI=1 and the per-run HOME. A parent's session variables would
# override --session-id and suppress transcript writes, so they are dropped.
launch_claude() { # session cwd [claude args...]
  local session="$1" cwd="$2" cmd
  shift 2
  cmd="$(printf '%q ' "$CLAUDE_BIN" --settings "$SETTINGS_FILE" "$@")"

  (
    export HOME="$RUN_HOME" CI=1 TERM=xterm-256color
    unset ANTHROPIC_API_KEY CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CONFIG_DIR
    if [ -n "$SPIKE_CONFIG_DIR" ]; then
      export CLAUDE_CONFIG_DIR="$SPIKE_CONFIG_DIR"
    fi
    exec tmux -L "$SPIKE_SOCKET" -f /dev/null new-session -d -s "$session" -x 200 -y 50 -c "$cwd" "$cmd"
  ) || note "tmux new-session failed for $session"
}

event_count() { # name
  local count
  count="$(grep -cF "\"hook_event_name\":\"$1\"" "$EVENTS_FILE" 2>/dev/null)" || true
  echo "${count:-0}"
}

event_seen() { # name
  [ "$(event_count "$1")" -gt 0 ]
}

event_count_above() { # name base
  [ "$(event_count "$1")" -gt "$2" ]
}

event_ts() { # name [index=1]; only valid when the event count is at least index
  { grep -F -m "${2:-1}" -- "\"hook_event_name\":\"$1\"" "$EVENTS_FILE" || true; } | tail -n 1 | cut -f1
}

event_field() { # name jq_filter [index=1]
  { grep -F -m "${3:-1}" -- "\"hook_event_name\":\"$1\"" "$EVENTS_FILE" || true; } | tail -n 1 | cut -f2- | jq -r "$2"
}

# Counts events of one hook by the tool_name of their payload: a Read call must not stand in for a Bash call.
event_tool_count() { # name tool
  local count
  count="$(cut -f2- "$EVENTS_FILE" 2>/dev/null | jq -Rn --arg name "$1" --arg tool "$2" '
    [inputs | fromjson? | select(.hook_event_name == $name and .tool_name == $tool)] | length' 2>/dev/null)" || true
  echo "${count:-0}"
}

# True while a permission dialog is open: a PermissionRequest with no later PostToolUse or PermissionDenied for the
# same tool. A dialog closed by a key (Esc) leaves no hook behind, so only an answer through the hook path lifts it.
dialog_open() {
  cut -f2- "$EVENTS_FILE" 2>/dev/null | jq -Rn -e '
    [inputs | fromjson?] as $events
    | any(range(0; $events | length);
        . as $i
        | $events[$i] as $request
        | $request.hook_event_name == "PermissionRequest"
          and ($events[$i + 1:]
            | map(select((.hook_event_name == "PostToolUse" or .hook_event_name == "PermissionDenied")
                and .tool_name == $request.tool_name))
            | length == 0))' >/dev/null 2>&1
}

# send_prompt behind the delivery guard: refuses (status 3) while a dialog is open, because Enter would answer it.
deliver_prompt() { # session file
  if dialog_open; then
    note "delivery refused: a permission dialog is open"
    return 3
  fi
  send_prompt "$@"
}

# The rule Step 3 implements in TypeScript. Strips C0 controls except LF, DEL, ESC and C1 (U+0080 to U+009F) after
# mapping tab to $SANITIZE_TAB, and exits 3 for a payload whose first non-blank character is `!` or `/` (bash mode,
# slash command): that one is rejected and never sent. The sanitised bytes are written either way.
SANITIZE_TAB=$'\t'
sanitize_payload() { # in_file out_file
  perl -MEncode -e '
    my ($in, $out, $tab) = @ARGV;
    open my $reader, "<:raw", $in or die "open $in: $!";
    my $text = decode("UTF-8", do { local $/; <$reader> }, Encode::FB_CROAK);
    $text =~ s/\t/$tab/g;
    $text =~ s/[\x00-\x09\x0b-\x1f\x7f-\x9f]//g;
    open my $writer, ">:raw", $out or die "open $out: $!";
    print {$writer} encode("UTF-8", $text);
    exit($text =~ m{\A\s*[!/]} ? 3 : 0);' "$1" "$2" "$SANITIZE_TAB"
}

# The text of the last user record of a transcript, empty when there is none.
transcript_last_user_text() { # transcript
  [ -f "$1" ] || return 0
  jq -R -n -r '
    [
      inputs
      | fromjson?
      | select(.type == "user")
      | .message.content
      | if type == "string" then .
        elif type == "array" then map(select(type == "object" and .type == "text") | .text) | join("")
        else "" end
      | select(length > 0)
    ]
    | (last // empty)' "$1"
}

# -r keeps LF instead of CR; -S keeps control bytes, which tmux 3.8 otherwise rewrites in caret form (ESC becomes ^[).
paste_text() { # session file
  local buffer="kdz-$$-$RANDOM"
  spike_tmux load-buffer -b "$buffer" - <"$2"
  spike_tmux paste-buffer -p -d -r -S -b "$buffer" -t "$1"
}

press() { # session key...
  local session="$1"
  shift
  spike_tmux send-keys -t "$session" "$@"
}

# Bracketed paste, then Enter on its own. Keys sent too soon after a paste may not submit, so Enter is re-sent on a
# growing delay until UserPromptSubmit shows. The delay of the Enter that worked is a paste_enter_delay_ms sample.
send_prompt() { # session file
  local session="$1" file="$2" base pasted_at sent_at step

  session_alive "$session" || return 1
  base="$(event_count UserPromptSubmit)"
  paste_text "$session" "$file" || return 1
  pasted_at="$(now_ms)"

  for step in 100 200 400 800 1600; do
    sleep_ms "$step"
    session_alive "$session" || return 1
    sent_at=$(($(now_ms) - pasted_at))
    press "$session" Enter
    if wait_for 1500 "$session" event_count_above UserPromptSubmit "$base"; then
      sample paste_enter_delay_ms "$sent_at"
      return 0
    fi
  done
  return 1
}

send_text() { # session text
  printf '%s' "$2" >"$CASE_DIR/prompt.txt"
  send_prompt "$1" "$CASE_DIR/prompt.txt"
}

# True when some user record of the transcript carries exactly the bytes of the expected file.
transcript_has_prompt() { # transcript expected_file
  [ -f "$1" ] || return 1
  jq -R -n -e --rawfile expected "$2" '
    [
      inputs
      | fromjson?
      | select(.type == "user")
      | .message.content
      | if type == "string" then .
        elif type == "array" then map(select(type == "object" and .type == "text") | .text) | join("")
        else "" end
    ]
    | any(. == $expected)' "$1" >/dev/null
}

sample() { # name value
  echo "$2" >>"$RUN_DIR/samples.$1"
}

# Prints `NUM <name>_p95 <value>` from the recorded samples, or `na` when there are none.
num_p95() { # name
  local file="$RUN_DIR/samples.$1" value="na"
  if [ -s "$file" ]; then
    value="$(sort -n "$file" | awk '
      { v[NR] = $1 }
      END { i = int(NR * 0.95); if (i < NR * 0.95) i++; print v[i] }')"
  fi
  printf 'NUM %s_p95 %s\n' "$1" "$value"
}

num() { # name value
  printf 'NUM %s %s\n' "$1" "$2"
}

# Prints the gate line and fails unless every check passed.
gate_report() { # name passed total
  printf 'GATE %s %s/%s\n' "$1" "$2" "$3"
  [ "$2" -eq "$3" ]
}
