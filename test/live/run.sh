#!/bin/sh
# Live test of the operator and agent packages (the sender and the receiver)
# in real Chromium on a Linux box with Xvfb, xdotool and ffmpeg (written on
# taylor). See README.md here.
#
#   test/live/run.sh             start everything, run every case, stop everything
#   test/live/run.sh up          start everything; print the run folder
#   test/live/run.sh test DIR    run the cases (or: test DIR case ...) against a started run
#   test/live/run.sh down DIR    stop every process of that run (through the run's guard)
#   test/live/run.sh displays    print the two displays that up would take now
#
# Environment: CHROMIUM (default /usr/bin/chromium), LIVE_PORT (default 8771),
# RECEIVER (the agent package folder to load; default the repository's agent/),
# LIVE_DISPLAY (the first X display to try; default 90; the displays of
# RESERVED_DISPLAYS are never taken), LIVE_UP_LIMIT (the seconds that a run of
# `up` alone may live without `down`; default 3600; it also ends a
# `test DIR` that is still running),
# HARNESS_LOCK_WAIT (the seconds to wait for the harness lock; default 1200).
#
# The two rules of every live harness (README.md, "Two rules"; board ab-v16.78):
# `up` takes the harness lock before it starts Xvfb or Chromium, through the
# guard harness_guard.py, and the guard stops every process of the run when
# its driver ends, also after a kill -9: in `all` mode the driver is this
# script; after `up` alone, `down` or LIVE_UP_LIMIT ends the run.
#
# The two Unix sockets of a run live in a short private folder
# /tmp/aw-live.XXXXXX (0700; env.json names it), because a socket path holds at
# most 107 bytes and the run folder of a deep checkout is longer. Everything
# else a run makes lives in test/live/.run/<stamp>/ (git-ignored): two throwaway
# Chromium profiles, a throwaway HOME, the X auth files (0600), logs,
# screenshots and results.json. This script deletes nothing: remove
# test/live/.run/ by hand when you are done (the system clears /tmp).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
CHROMIUM=${CHROMIUM:-/usr/bin/chromium}
PORT=${LIVE_PORT:-8771}
FIRST_DISPLAY=${LIVE_DISPLAY:-90}
RECEIVER=${RECEIVER:-$REPO/agent}  # another agent package folder, for example agentwatch's pinned copy

say() { echo "run.sh: $*" >&2; }

ext_id() { sed -n "s/^- $1 extension ID: \`\([a-p]\{32\}\)\`$/\1/p" "$REPO/docs/protocol.md"; }

# The displays that run.sh never takes, whatever LIVE_DISPLAY is: 0 (a
# desktop), 90 (agentwatch's agent browser on taylor, the operator's), 147, 190,
# 191, 192 (other programs' displays on taylor). When such a display stops, its
# socket and lock file go, so the free test alone would take it. The same list
# as RESERVED_DISPLAYS in harness_guard.py (a test compares them).
RESERVED_DISPLAYS="0 90 147 190 191 192"

# A display number from $1 (at least 1) to 189 that is not reserved and has no
# X socket and no lock file.
free_display() {
  n=$1
  case "$n" in '' | *[!0-9]*) n=1 ;; esac
  n=${n#"${n%%[!0]*}"} # no leading zero (sh reads 089 as octal)
  [ -n "$n" ] || n=1
  while [ "$n" -le 189 ]; do
    case " $RESERVED_DISPLAYS " in
      *" $n "*)
        n=$((n + 1))
        continue
        ;;
    esac
    if [ ! -e "/tmp/.X11-unix/X$n" ] && [ ! -e "/tmp/.X$n-lock" ]; then
      echo "$n"
      return 0
    fi
    n=$((n + 1))
  done
  return 1
}

# An Xauthority file (0600) with one FamilyWild MIT-MAGIC-COOKIE-1 entry. The
# cookie comes from os.urandom inside Python and never enters an argv.
write_xauth() {
  python3 - "$1" "$2" <<'EOF'
import os, struct, sys
display, path = sys.argv[1], sys.argv[2]
field = lambda b: struct.pack(">H", len(b)) + b
entry = (struct.pack(">H", 0xFFFF) + field(b"") + field(display.encode()) +
         field(b"MIT-MAGIC-COOKIE-1") + field(os.urandom(16)))
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "wb") as f:
    f.write(entry)
EOF
}

start_xvfb() {  # RUN N
  Xvfb ":$2" -nolisten tcp -auth "$1/x/auth.$2" -screen 0 1280x900x24 >"$1/logs/xvfb.$2.log" 2>&1 &
  echo $! >"$1/pids/xvfb.$2"
  i=0
  while [ ! -e "/tmp/.X11-unix/X$2" ]; do
    i=$((i + 1))
    [ "$i" -le 50 ] || { say "Xvfb :$2 did not start"; return 1; }
    sleep 0.2
  done
  # The display answers with the cookie and refuses a client without it.
  env -i PATH=/usr/bin:/bin DISPLAY=":$2" XAUTHORITY="$1/x/auth.$2" xdotool getmouselocation >/dev/null
  if env -i PATH=/usr/bin:/bin DISPLAY=":$2" XAUTHORITY=/dev/null xdotool getmouselocation >/dev/null 2>&1; then
    say "display :$2 accepted a client without the cookie"
    return 1
  fi
}

start_chromium() {  # RUN NAME DISPLAY PROFILE EXTENSION [FLAG...]
  run=$1 name=$2 display=$3 profile=$4 ext=$5
  shift 5
  env -i HOME="$run/home" PATH=/usr/bin:/bin LANG=C.UTF-8 DISPLAY=":$display" XAUTHORITY="$run/x/auth.$display" \
    "$CHROMIUM" --user-data-dir="$profile" --no-first-run --no-default-browser-check --password-store=basic \
    --load-extension="$ext" "$@" --window-position=0,0 --window-size=1280,900 about:blank \
    >"$run/logs/chromium-$name.log" 2>&1 &
  echo $! >"$run/pids/chromium-$name"
}

up() {  # [all]
  if ss -ltn | grep -q "127.0.0.1:$PORT "; then
    say "port $PORT is in use; set LIVE_PORT"
    return 1
  fi
  sender_id=$(ext_id Sender)
  receiver_id=$(ext_id Receiver)
  [ -n "$sender_id" ] && [ -n "$receiver_id" ] || { say "no extension IDs in docs/protocol.md"; return 1; }

  umask 077
  mkdir -p "$HERE/.run"
  run="$HERE/.run/$(date +%Y%m%d-%H%M%S)"
  mkdir "$run"
  # From here on, a failed step (set -e also ends the $(up) subshell of
  # "all") stops whatever this run started. A successful up clears the trap.
  trap 'down "$run"' EXIT
  trap 'exit 130' INT TERM
  mkdir "$run/home" "$run/logs" "$run/shots" "$run/x" "$run/pids"
  # The harness lock and the guard, before the displays are chosen. The guard
  # reads each pid file of $run/pids and stops those processes (and their
  # children) at the driver's end: this script's end in `all` mode, else `down`
  # or LIVE_UP_LIMIT. It leaves this script's process tree at once.
  if [ "${1:-}" = all ]; then
    set -- --driver "$$"
  else
    set -- --driver 0 --limit "${LIVE_UP_LIMIT:-3600}"
  fi
  answer=$(python3 -I -B "$HERE/harness_guard.py" --name chrome-extension-live "$@" --pid-dir "$run/pids" --log "$run/logs/guard.log") || true
  case "$answer" in
    locked\ * | nested\ *) echo "$answer" | cut -d' ' -f2 >"$run/guard.pid" ;;
    *)
      say "${answer#refused }"
      return 2
      ;;
  esac
  sock=$(mktemp -d /tmp/aw-live.XXXXXX)

  a=$(free_display "$FIRST_DISPLAY")
  o=$(free_display $((a + 1)))
  write_xauth "$a" "$run/x/auth.$a"
  write_xauth "$o" "$run/x/auth.$o"
  start_xvfb "$run" "$a"
  start_xvfb "$run" "$o"

  # The operator's sender: a copy whose manifest gains a test-only shortcut
  # for the popup. The key stays, so the extension ID stays.
  cp -R "$REPO/operator" "$run/sender-copy"
  python3 - "$run/sender-copy/manifest.json" <<'EOF'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    m = json.load(f)
m["commands"] = {"_execute_action": {"suggested_key": {"default": "Ctrl+Shift+U"}}}
with open(path, "w", encoding="utf-8") as f:
    json.dump(m, f, indent=2)
EOF

  # The agent profile's native messaging host: a 0700 wrapper that runs host.py.
  mkdir -p "$run/agent/NativeMessagingHosts"
  cat >"$run/native-host" <<EOF
#!/bin/sh
exec /usr/bin/python3 "$HERE/host.py" --socket "$sock/daemon.sock" --log "$run/logs/host.log" "\$@"
EOF
  chmod 0700 "$run/native-host"
  cat >"$run/agent/NativeMessagingHosts/sh.agentwatch.browser.json" <<EOF
{"name": "sh.agentwatch.browser", "description": "agentwatch live test relay", "path": "$run/native-host",
 "type": "stdio", "allowed_origins": ["chrome-extension://$receiver_id/"]}
EOF

  python3 "$HERE/server.py" --run "$run" --sockets "$sock" --port "$PORT" --sender-id "$sender_id" >"$run/logs/server.log" 2>&1 &
  echo $! >"$run/pids/server"
  i=0
  while [ ! -S "$sock/ctl.sock" ]; do
    i=$((i + 1))
    [ "$i" -le 50 ] || { say "server.py did not start"; return 1; }
    sleep 0.2
  done

  # www.plain.test: a plain-http site that is not localhost (Chrome sends it no
  # Sec-Fetch-* header), on the same loopback server; .test is never a real site.
  start_chromium "$run" agent "$a" "$run/agent" "$RECEIVER" --silent-debugger-extension-api \
    "--host-resolver-rules=MAP www.plain.test 127.0.0.1"
  start_chromium "$run" operator "$o" "$run/operator" "$run/sender-copy"

  cat >"$run/env.json" <<EOF
{"run": "$run", "sockets": "$sock", "port": $PORT, "sender_id": "$sender_id", "receiver_id": "$receiver_id",
 "agent": {"display": $a, "xauth": "$run/x/auth.$a"}, "operator": {"display": $o, "xauth": "$run/x/auth.$o"}}
EOF
  say "agent Chromium on :$a, operator Chromium on :$o, sites and box on 127.0.0.1:$PORT"
  sleep 3
  trap - EXIT INT TERM
  echo "$run"
}

down() {  # RUN
  # Only through the run's own guard (its pid in guard.pid, its command line
  # names this run's pid folder): the guard stops the run's processes by their
  # recorded start times, and down waits until the guard has ended. A guard
  # that is gone already stopped the run (at the driver's end or at
  # LIVE_UP_LIMIT): then down signals nothing, because a pid file of the run
  # can name a process that took that pid later.
  run=$1
  if [ ! -f "$run/guard.pid" ]; then
    say "the run $run has no guard.pid (its guard did not start, so it started nothing): down signals nothing"
    return 0
  fi
  g=$(cat "$run/guard.pid")
  case "$g" in '' | *[!0-9]*) g=0 ;; esac
  if [ "$g" -gt 0 ] && grep -q -F "$run/pids" "/proc/$g/cmdline" 2>/dev/null; then
    kill "$g" 2>/dev/null || true
    i=0
    while grep -q -F "$run/pids" "/proc/$g/cmdline" 2>/dev/null; do
      i=$((i + 1))
      if [ "$i" -gt 300 ]; then
        say "the guard $g of $run still runs after 30 s; see $run/logs/guard.log"
        return 1
      fi
      sleep 0.1
    done
    say "stopped the processes of $run (through its guard $g)"
  else
    say "the guard already stopped the run $run: down signals nothing"
  fi
}

case "${1:-all}" in
  up) up ;;
  test) shift; run=$1; shift; python3 "$HERE/live.py" "$run" "$@" ;;
  down) down "$2" ;;
  displays)
    a=$(free_display "$FIRST_DISPLAY") && o=$(free_display $((a + 1))) && echo "$a $o"
    ;;
  all)
    run=$(up all)
    trap 'down "$run"' EXIT INT TERM
    python3 "$HERE/live.py" "$run"
    ;;
  *) say "usage: run.sh [up | test DIR [case...] | down DIR | displays]"; exit 2 ;;
esac
