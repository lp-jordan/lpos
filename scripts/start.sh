#!/bin/bash
# LPOS Dashboard — launchd startup wrapper.
# launchd runs with a bare environment so we must supply PATH and env vars
# explicitly rather than relying on the user's shell profile.

export PATH="/Users/lpos/.nvm/versions/node/v24.14.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export NODE_ENV=production
export NODE_OPTIONS="--disable-warning=ExperimentalWarning"

# ── Crash loop guard ───────────────────────────────────────────────────────────
# If the server fails to stay up, launchd will keep retrying every 10 s.
# This guard counts recent launch attempts and calls bootout after MAX_ATTEMPTS
# within WINDOW_SECS, breaking the loop and keeping the machine stable.
# Logs the bail-out to the standard error log so it's visible in Console.app.
#
# To recover after a bail-out:
#   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.lpos.dashboard.plist
# ──────────────────────────────────────────────────────────────────────────────
MAX_ATTEMPTS=5
WINDOW_SECS=300   # 5 minutes
GUARD_FILE="/tmp/lpos-crash-guard"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/com.lpos.dashboard"

now=$(date +%s)

# Read existing timestamps; drop any outside the window
recent=()
if [[ -f "$GUARD_FILE" ]]; then
  while IFS= read -r ts; do
    if (( now - ts < WINDOW_SECS )); then
      recent+=("$ts")
    fi
  done < "$GUARD_FILE"
fi

# Record this attempt
recent+=("$now")
printf '%s\n' "${recent[@]}" > "$GUARD_FILE"

if (( ${#recent[@]} > MAX_ATTEMPTS )); then
  echo "[lpos-start] $(date): crash loop detected — ${#recent[@]} starts in ${WINDOW_SECS}s. Calling bootout to stop the loop. Re-enable with: launchctl bootstrap \"$DOMAIN\" ~/Library/LaunchAgents/com.lpos.dashboard.plist" >&2
  rm -f "$GUARD_FILE"
  launchctl bootout "$SERVICE"
  exit 0   # Exit 0 so launchd doesn't try one more time after bootout
fi
# ─────────────────────────────────────────────────────────────────────────────

cd /Users/lpos/lp-app-ecosystem/lpos-dashboard

# doppler injects secrets; tsx runs the TypeScript entry point directly.
# Redirect stdout into stderr so both streams land in the same log file
# (launchd routes stderr → err.log; out.log stays empty but that's fine).
exec doppler run -- node ./node_modules/.bin/tsx server.ts 1>&2
