#!/bin/bash
set -e

# Clear stale lock/socket files from previous crash loops.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 || true
pkill -f "Xvfb :99" >/dev/null 2>&1 || true

# Start virtual display for headed Chrome (LinkedIn detects headless)
# PERF (Phase 2.3): 1366x768 matches the viewport Playwright actually uses
# (see worker/src/browser.js) — rendering at 1920x1080 wastes CPU/RAM. Depth 16
# is plenty for a debug-only VNC view. Override via XVFB_* env if needed.
export XVFB_WIDTH="${XVFB_WIDTH:-1366}"
export XVFB_HEIGHT="${XVFB_HEIGHT:-768}"
export XVFB_DEPTH="${XVFB_DEPTH:-16}"
Xvfb :99 -screen 0 ${XVFB_WIDTH}x${XVFB_HEIGHT}x${XVFB_DEPTH} -ac +extension GLX +render -noreset &
XVFB_PID=$!

export DISPLAY=:99
export NOVNC_PORT="${NOVNC_PORT:-6080}"

cleanup() {
  if [ -n "${NOVNC_PID:-}" ]; then
    kill "${NOVNC_PID}" 2>/dev/null || true
  fi
  if [ -n "${X11VNC_PID:-}" ]; then
    kill "${X11VNC_PID}" 2>/dev/null || true
  fi
  kill "${XVFB_PID}" 2>/dev/null || true
  exit 0
}

# Trap signals to clean up Xvfb on container stop
trap cleanup SIGTERM SIGINT

# Wait for Xvfb to be ready (up to 10 seconds)
for i in {1..20}; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  echo "[entrypoint] FATAL: Xvfb failed to start"
  exit 1
fi

echo "[entrypoint] Xvfb started on :99"
echo "[entrypoint] Display size: ${XVFB_WIDTH}x${XVFB_HEIGHT}x${XVFB_DEPTH}"
echo "[entrypoint] Starting noVNC bridge on :${NOVNC_PORT}"
# Belt-and-suspenders: x11vnc auto-loads any of these files if present and
# advertises RFB security type 2 (password) even when -nopw is passed.
# Wipe them so the server is guaranteed to advertise security type 1 (None).
rm -f /tmp/novnc-password \
      "${HOME}/.vnc/passwd" \
      /root/.vnc/passwd \
      /etc/x11vnc.pass \
      /etc/vnc/passwd \
      /usr/local/etc/x11vnc.pass 2>/dev/null || true
# IMPORTANT: do NOT pass -rfbauth here. -rfbauth <file> activates RFB security
# type 2 (VNC auth) reading the password from the file — even when the file is
# /dev/null or empty, x11vnc still advertises that auth is required and noVNC
# shows the "Password:" prompt. Passing only -nopw (and nothing else
# auth-related) makes x11vnc advertise security type 1 (None) and noVNC
# connects with no prompt.
#
# PERF (Phase 2.3): -wait 50 throttles polling to ~20fps max instead of the
# default ~10ms (~100fps). -ncache 0 disables client-side caching that wastes
# server memory. -noxdamage avoids the XDAMAGE extension which spins under
# Chromium animations on Xvfb. Together these drop idle CPU from ~30% → <5%.
x11vnc -display :99 -forever -shared -nopw \
  -wait 50 -defer 30 -ncache 0 -noxdamage \
  -listen 0.0.0.0 -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
X11VNC_PID=$!
websockify --web /usr/share/novnc/ "${NOVNC_PORT}" localhost:5900 >/tmp/novnc.log 2>&1 &
NOVNC_PID=$!
echo "[entrypoint] Applying Prisma migrations..."
if ! npx prisma migrate deploy --schema=prisma/schema.prisma; then
  echo "[entrypoint] migrate deploy failed; applying idempotent SQL migration fallback..."
  for migration in prisma/migrations/*/migration.sql; do
    if [ -f "$migration" ]; then
      echo "[entrypoint] Applying fallback migration: $migration"
      npx prisma db execute \
        --config=prisma.config.ts \
        --file="$migration"
    fi
  done
fi
echo "[entrypoint] Starting worker..."

exec node src/index.js
