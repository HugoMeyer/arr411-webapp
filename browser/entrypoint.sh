#!/bin/sh
# Remote browser of the C411 view: a virtual display, a relay for the DevTools port and Chromium.
# Chromium has no route to the Internet other than the egress proxy (see docker-compose.yml).
set -eu

PROXY="${EGRESS_PROXY:-http://egress:3128}"
PROXY_HOST="${PROXY#*://}"
PROXY_HOST="${PROXY_HOST%%:*}"
PROFILE=/tmp/profile

# The root file system is read-only: everything Chromium writes goes under /tmp (a tmpfs, empty at each start).
export HOME=/tmp/home
export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache"
rm -rf "$PROFILE" "$HOME"
mkdir -p "$PROFILE" "$HOME"

HEADLESS=""
if [ "${BROWSER_HEADLESS:-0}" = "1" ]; then
  HEADLESS="--headless=new"
else
  export DISPLAY=:99
  # Xvfb only creates its socket in a directory that already exists (it cannot create it without root).
  mkdir -p /tmp/.X11-unix
  chmod 1777 /tmp/.X11-unix
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp &
  XVFB_PID=$!
  i=0
  while [ ! -S /tmp/.X11-unix/X99 ]; do
    i=$((i + 1))
    if [ "$i" -gt 100 ] || ! kill -0 "$XVFB_PID" 2>/dev/null; then
      echo "Xvfb did not start" >&2
      exit 1
    fi
    sleep 0.1
  done
fi

# Chromium only listens on the loopback address for DevTools: the relay makes it reachable by the arr411 container.
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &

# shellcheck disable=SC2086
exec chromium $HEADLESS \
  --no-sandbox \
  --disable-gpu \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --proxy-server="$PROXY" \
  --proxy-bypass-list="<-loopback>" \
  --host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE $PROXY_HOST" \
  --webrtc-ip-handling-policy=disable_non_proxied_udp \
  --force-webrtc-ip-handling-policy \
  --deny-permission-prompts \
  --password-store=basic \
  --lang=fr-FR \
  --window-size=1920,1080 \
  --disable-background-networking \
  --disable-component-update \
  --disable-sync \
  --disable-default-apps \
  --disable-breakpad \
  --disable-features=Translate,MediaRouter,OptimizationHints \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --mute-audio \
  --no-first-run \
  --no-default-browser-check \
  about:blank
