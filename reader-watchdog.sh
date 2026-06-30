#!/usr/bin/env bash
# Raijin reader watchdog.
# Runs harness.js (drives the real reader.js); if it reports BROKEN (exit 1) the
# site rotated its obfuscation, so launch claude --dangerously-skip-permissions
# to patch reader.js.
# A flock lock guarantees only one claude runs at a time: the lock is held for
# the whole duration (healthcheck + claude), so an overlapping timer tick that
# fires while claude is still working just skips.
set -uo pipefail

REPO="/home/romain/dev/raijin-scans"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/raijin-reader-watchdog.lock"
LOG="$REPO/watchdog.log"
CLAUDE="$HOME/.local/bin/claude"
# bun runs the canary. systemd user services get a minimal PATH, so resolve it:
# prefer one on PATH, else fall back to an nvm-installed bun.
BUN="${BUN:-$(command -v bun || true)}"
[ -z "$BUN" ] && BUN="$(ls "$HOME"/.nvm/versions/node/*/bin/bun 2>/dev/null | head -1)"

# Circuit breaker: if claude is launched MAX_RUNS times within WINDOW seconds the
# site is rotating faster than we can patch (or claude is stuck re-patching in a
# loop). Stop chasing it: disable the timer and stop launching claude.
HIST="$REPO/.watchdog-runs"   # one epoch-seconds line per claude launch
WINDOW=3600                   # look-back window (1h)
MAX_RUNS=3                    # launches in WINDOW that count as "too fast / loop"

log() { echo "$(date -Is) $*" >>"$LOG"; }

# stop the timer so no further ticks fire and claude is never re-invoked
disarm() {
  log "circuit breaker tripped -> disabling raijin-watchdog.timer ($*)"
  systemctl --user disable --now raijin-watchdog.timer >>"$LOG" 2>&1 || \
    log "WARN: could not disable timer (run: systemctl --user disable --now raijin-watchdog.timer)"
}

# Single-instance: non-blocking lock. If held, another run (likely claude still
# patching) is in progress -> skip this tick rather than launch a second claude.
exec 9>"$LOCK"
if ! flock -n 9; then
  log "lock held, skip tick"
  exit 0
fi

cd "$REPO" || { log "cannot cd $REPO"; exit 1; }

HEALTH="${XDG_RUNTIME_DIR:-/tmp}/raijin-health.json"
if [ -z "$BUN" ]; then
  log "bun not found (set BUN= or install bun); skipping tick"
  exit 0
fi
"$BUN" harness.js --json --flaresolverr "${FLARESOLVERR:-http://localhost:8191/v1}" >"$HEALTH" 2>>"$LOG"
code=$?
detail="$("$BUN" -e 'console.log((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).detail)||"")' "$HEALTH" 2>/dev/null)"
log "healthcheck exit $code ${detail:+- $detail}"

case "$code" in
  0) ;;  # healthy
  2) ;;  # inconclusive (transport/capture) -> not the scraper's fault, ignore
  1)
    # Prune launch history to the window, then count recent launches.
    now=$(date +%s)
    if [ -f "$HIST" ]; then
      awk -v cutoff=$((now - WINDOW)) '$1 >= cutoff' "$HIST" >"$HIST.tmp" && mv "$HIST.tmp" "$HIST"
    fi
    recent=$( [ -f "$HIST" ] && wc -l <"$HIST" || echo 0 )
    if [ "$recent" -ge "$MAX_RUNS" ]; then
      disarm "$recent claude launches in ${WINDOW}s; not launching again"
      exit 0
    fi
    echo "$now" >>"$HIST"

    log "BROKEN -> launching claude to patch reader.js (launch $((recent + 1))/$MAX_RUNS in window)"
    "$CLAUDE" --dangerously-skip-permissions -p "The Raijin Scans reader healthcheck reports BROKEN: raijin-scans rotated its reader obfuscation and reader.js no longer descrambles. Healthcheck detail: ${detail:-(see watchdog.log)}. Read MAINTENANCE.md, capture a fresh chapter via FlareSolverr, diff the manifest shape, and patch reader.js (and the DEFAULT_SCRIPT/PARSER_VERSION in ReaderScriptManager.kt if the JS<->Kotlin contract changed). Validate with bun -c reader.js and bun harness.js. Commit and push the modifications made to reader. IMPORTANT loop guard: if you find raijin-scans is rotating its obfuscation too fast to keep up, or you are repeatedly patching the same thing / healthcheck stays BROKEN after your fix (a patch loop), do NOT keep retrying or schedule any re-invocation of yourself — instead stop the watchdog by running 'systemctl --user disable --now raijin-watchdog.timer' and report that you disabled it and why." >>"$LOG" 2>&1
    log "claude exited $?"
    ;;
  *) log "unexpected healthcheck exit $code" ;;
esac
