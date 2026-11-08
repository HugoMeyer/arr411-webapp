# Remote browser of the C411 view (Chromium on a virtual display, driven by Arr411 through DevTools).
# It only runs on the two internal networks of docker-compose.yml (c411-control and c411-egress): DevTools has no
# authentication, so its port must never be published.
FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium xvfb socat tini ca-certificates tzdata \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 --shell /usr/sbin/nologin browser

COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

USER browser
WORKDIR /home/browser
EXPOSE 9223

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/9223 && printf "GET /json/version HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n" >&3 && head -n 1 <&3 | grep -q " 200 "' || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
