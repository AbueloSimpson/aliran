# Aliran library — standalone VOD service. Needs ffmpeg + ffprobe (one-shot ingest
# transcode/remux). No inbound ports for P2P (outbound UDP; network_mode: host
# recommended so hole-punching is not degraded by bridge NAT).
# BUILD FROM THE REPO ROOT (the image needs the @aliran/core workspace package):
#   docker build -f library/Dockerfile -t aliran-library .
# docker-compose.yml already does this (context: ., dockerfile: library/Dockerfile —
# the service sits behind the `vod` compose profile: operators who don't run VOD
# simply never start it).
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# @aliran/core is an unpublished workspace package, vendored into the image and
# resolved via the file:../core dependency. Install core's own deps first.
COPY core/ core/
COPY library/package.json library/
RUN cd core && npm install --omit=dev \
 && cd ../library && npm install --omit=dev

COPY library/src library/src
COPY library/control-ui library/control-ui

# Titles live under /data (registry + secrets + the per-title encrypted stores).
# Disk = the sum of title sizes — operator-managed, reclaimed only by delete-title.
ENV DATA_DIR=/data
VOLUME ["/data"]

WORKDIR /app/library

# The control dashboard (CONTROL_ENABLED=1) binds 127.0.0.1:3320 by default; run with
# network_mode: host and put Caddy/SSH in front — see deploy/ and docs/operator-guide.md.
CMD ["node", "src/index.js"]
