#!/bin/sh
#
# Run a command, then reap any `opencode serve` process it left behind.
#
# The driver boots one server per session through the SDK's `createOpencodeServer`, and
# `disposeAll` only reaps them when the bin exits through SIGTERM or stdin EOF. A local run that
# ends any other way (a crashed test process, `timeout` firing, ctrl-c) leaves the server alive:
# it is a grandchild, so it reparents to pid 1 and never sees a signal. Eleven of them, alive for
# four days and each holding its own MCP subprocess, is what prompted this wrapper.
#
# macOS ships no `setsid`, so process-group tricks are not portable here. Recording which servers
# existed before the run and killing whatever is new afterwards works regardless of how the run
# ends, and regardless of whether the caller wrapped it in `timeout`.
#
# Usage: ./scripts/reap-opencode.sh bun test test/integration

set -u

#: Servers already running before this command started are somebody else's and must survive.
before=$(pgrep -f "[o]pencode serve" 2>/dev/null | tr '\n' ' ')

reap() {
    leaked=''

    for pid in $(pgrep -f "[o]pencode serve" 2>/dev/null); do
        case " ${before} " in
            *" ${pid} "*) continue ;;
        esac

        kill -TERM "${pid}" 2>/dev/null || true
        leaked="${leaked}${pid} "
    done

    if [ -n "${leaked}" ]; then
        printf 'reap-opencode: terminated leaked servers %s\n' "${leaked}" >&2
    fi
}

#: Signalled runs stop the command first, otherwise the reaper would inspect a still-live tree and
#: find nothing to collect. 143 is the conventional 128 + SIGTERM.
trap 'kill -TERM "${child:-}" 2>/dev/null; reap; exit 143' HUP INT TERM

# Backgrounded rather than run in the foreground on purpose: a POSIX shell defers trap handling
# until the foreground command returns, so a signalled wrapper would sit on its hands until the
# very run it is supposed to clean up after finished on its own. `wait` is interruptible.
"$@" &
child=$!
wait "${child}"
status=$?

reap

exit "${status}"
