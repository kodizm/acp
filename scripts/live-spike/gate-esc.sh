#!/usr/bin/env bash
# Gate esc: can an Esc keystroke interrupt a running turn, and is the interrupt visible from the transcript?
#
# CLI 2.1.280 behaves differently on either side of the first output token. After streaming started, Esc writes a
# user record `[Request interrupted by user]` to the transcript; before it, Esc restores the prompt into the composer
# and writes nothing. So the gate waits until the reply is streaming, then sends Esc, and passes an iteration when a
# new `[Request interrupted by user` record shows within 5 s. Esc fires no hook, so the transcript marker is the only
# signal. Streaming is seen as the first assistant text in the transcript or numbers streamed into the pane (the
# transcript only gains the text at the interrupt); a turn that already ended before the Esc counts as a failure.
#
# After each iteration the composer is cleared (C-u) and the gate waits for an idle pane, so no run inherits the
# previous one's leftovers. Then 10 pre-output Escapes (0.3 s after the submit) are recorded as an observation:
# whether a marker shows and whether the composer shows the prompt again. The pane is never a state source for the
# design, only for this observation.
#
# Needs a model whose reply streams long enough to Esc into (a scripted local mock endpoint that streams slowly, or
# a cheap real model), selected through ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN.
#   KDZ_ESC_TOTAL             Esc-after-output iterations (default 30)
#   KDZ_ESC_PREOUTPUT_TOTAL   pre-output Escapes (default 10)
#   KDZ_TURN_TIMEOUT_S        how long to wait for the first output (default 60)
#
#   bash gate-esc.sh [--self-test]
#
# Prints NUM esc_detect_ms_p95, NUM esc_preoutput_marker, NUM esc_preoutput_composer_restored, `GATE esc <n>/30`.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SPIKE_DIR/lib.sh"

TOTAL="${KDZ_ESC_TOTAL:-30}"
MAX_ITER="${KDZ_ESC_MAX_ITER:-150}"
PREOUTPUT_TOTAL="${KDZ_ESC_PREOUTPUT_TOTAL:-10}"
DETECT_LIMIT_MS=5000
OUTPUT_TIMEOUT_MS=$((${KDZ_TURN_TIMEOUT_S:-60} * 1000))
SESSION="kdz-esc"
# A different range per call: the same prompt repeated in one conversation makes the model answer short.
prompt_for() { # call-number
  echo "Without using any tool, write the integers from $(($1 * 7919 + 1)) to $(($1 * 7919 + 6000)) directly in your reply, one per line, and nothing else."
}
PROMPT_HEAD="Without using any tool"
TRANSCRIPT=""

spike_init "$@"

interrupt_count() {
  local count
  count="$(grep -cF 'Request interrupted by user' "$TRANSCRIPT" 2>/dev/null)" || true
  echo "${count:-0}"
}

interrupt_count_above() { # base
  [ "$(interrupt_count)" -gt "$1" ]
}

assistant_text_count() {
  local count
  count="$(jq -R -n '
    [inputs | fromjson? | select(.type == "assistant") | .message.content[]? | select(.type == "text")] | length
  ' "$TRANSCRIPT" 2>/dev/null)" || true
  echo "${count:-0}"
}

# Number-only lines under the last echo of the prompt: the older iterations' numbers stay on screen after an Esc.
pane_streamed_lines() {
  spike_tmux capture-pane -p -t "$SESSION" |
    awk -v head="$PROMPT_HEAD" '
      index($0, "❯") > 0 && index($0, head) > 0 { count = 0; next }
      /^[[:space:]]*(⏺ )?[0-9]+[[:space:]]*$/ { count++ }
      END { print count + 0 }'
}

streaming_started() { # assistant_text_base
  [ "$(assistant_text_count)" -gt "$1" ] || [ "$(pane_streamed_lines)" -ge 3 ]
}

# The composer is what sits between the last two horizontal rules.
pane_composer() {
  spike_tmux capture-pane -p -t "$SESSION" |
    awk '
      /^────/ { before = last; last = NR; next }
      { line[NR] = $0 }
      END { for (i = before + 1; i < last; i++) print line[i] }'
}

pane_busy() {
  spike_tmux capture-pane -p -t "$SESSION" | grep -qF 'esc to interrupt'
}

pane_idle() {
  if pane_busy; then
    return 1
  fi
  # The prompt glyph is followed by a no-break space; keeping only ASCII letters, digits and punctuation drops both.
  [ -z "$(pane_composer | LC_ALL=C tr -cd '[:alnum:][:punct:]')" ]
}

composer_shows_prompt() {
  pane_composer | grep -qF "$PROMPT_HEAD"
}

# Leaves the pane ready for the next prompt: stops a turn that still runs, empties the composer, waits for idle.
settle_pane() {
  # A second Esc on a pane that is not running a turn swallows the C-u that follows, so Esc only goes to a busy pane.
  if pane_busy; then
    press "$SESSION" Escape || true
    sleep 0.5
  fi
  press "$SESSION" C-u || true
  wait_for 3000 "$SESSION" pane_idle && return 0
  press "$SESSION" C-u || true
  wait_for 12000 "$SESSION" pane_idle || note "esc: pane did not settle"
}

passed=0
preoutput_marker=0
preoutput_composer=0
workdir="$(new_workdir esc)"
seed_trust "$workdir"
prepare_case esc
launch_claude "$SESSION" "$workdir"

status=0
wait_for 15000 "$SESSION" event_seen SessionStart || status=$?

if [ "$status" -eq 0 ]; then
  TRANSCRIPT="$(event_field SessionStart '.transcript_path // empty')"
  [ -n "$TRANSCRIPT" ] || note "esc: SessionStart carried no transcript_path"
else
  note "esc: no SessionStart (wait status $status)"
fi

if [ -n "$TRANSCRIPT" ]; then
  # 1. Esc once the reply streams: the marker must follow.
  # An iteration whose turn ended before the Esc could go out sent no Esc, so it does not count: the loop runs until
  # TOTAL Escapes were sent (or MAX_ITER iterations), and `passed` counts the detected ones among them.
  sent=0
  for ((i = 1; i <= MAX_ITER && sent < TOTAL; i++)); do
    session_alive "$SESSION" || { note "esc: session died before iteration $i"; break; }

    interrupt_base="$(interrupt_count)"
    stop_base="$(event_count Stop)"
    text_base="$(assistant_text_count)"

    if ! send_text "$SESSION" "$(prompt_for "$i")"; then
      note "esc: iteration $i prompt not submitted"
      settle_pane
      continue
    fi

    # A fixed delay, not a pane or transcript probe: those misfire on the numbers an earlier iteration left on screen.
    sleep "${KDZ_ESC_AFTER_S:-6}"
    if [ "$(event_count Stop)" -gt "$stop_base" ]; then
      note "esc: iteration $i turn ended before the Esc"
    else
      pressed_at="$(now_ms)"
      press "$SESSION" Escape
      sent=$((sent + 1))
      if wait_for "$DETECT_LIMIT_MS" "$SESSION" interrupt_count_above "$interrupt_base"; then
        sample esc_detect_ms "$(($(now_ms) - pressed_at))"
        passed=$((passed + 1))
      else
        note "esc: iteration $i no interrupt marker within ${DETECT_LIMIT_MS} ms"
      fi
    fi
    settle_pane
  done

  # 2. Esc before the first output token: observation only.
  for ((i = 1; i <= PREOUTPUT_TOTAL; i++)); do
    session_alive "$SESSION" || { note "esc: session died before pre-output $i"; break; }

    interrupt_base="$(interrupt_count)"
    if ! send_text "$SESSION" "$(prompt_for "$((1000 + i))")"; then
      note "esc: pre-output $i prompt not submitted"
      settle_pane
      continue
    fi

    sleep 0.3
    press "$SESSION" Escape
    if wait_for 2000 "$SESSION" interrupt_count_above "$interrupt_base"; then
      preoutput_marker=$((preoutput_marker + 1))
    fi
    if composer_shows_prompt; then
      preoutput_composer=$((preoutput_composer + 1))
    fi
    settle_pane
  done
fi

num_p95 esc_detect_ms
num esc_preoutput_marker "$preoutput_marker/$PREOUTPUT_TOTAL"
num esc_preoutput_composer_restored "$preoutput_composer/$PREOUTPUT_TOTAL"
gate_report esc "$passed" "$TOTAL"
