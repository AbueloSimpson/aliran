# Aliran broadcaster — needs ffmpeg. No inbound ports for P2P (outbound UDP);
# push ingest (RTMP/SRT/TS listeners), when configured, needs its ports reachable —
# with network_mode: host they are, no port mapping required.
# BUILD FROM THE REPO ROOT (the image needs the @aliran/core workspace package):
#   docker build -f broadcaster/Dockerfile -t aliran-broadcaster .
# docker-compose.yml already does this (context: ., dockerfile: broadcaster/Dockerfile).
FROM node:24-bookworm-slim

# Debian bookworm's ffmpeg ships with libsrt — SRT ingest works out of the box.
# fonts-dejavu-core is for the offline-slate render below: drawtext needs a real font file,
# and pinning it explicitly keeps the build from depending on whatever ffmpeg happens to
# pull in transitively.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# @aliran/core is an unpublished workspace package, vendored into the image and
# resolved via the file:../core dependency. Install core's own deps first.
COPY core/ core/
COPY broadcaster/package.json broadcaster/
RUN cd core && npm install --omit=dev \
 && cd ../broadcaster && npm install --omit=dev

COPY broadcaster/src broadcaster/src
COPY broadcaster/control-ui broadcaster/control-ui

# Render the offline-slate media INTO the image (default SLATE_DIR = broadcaster/slate).
# Building them here rather than committing ~2.6 MB of binaries means the files are produced
# by the exact ffmpeg that will later loop them — no dev-box/container version skew, which is
# the one thing that could silently break the -c copy remux. Cached until the script changes.
# Override SLATE_DIR to serve them off the data volume instead; SLATE_ENABLED=0 turns the
# whole feature off. See docs/kb/offline-slate.md.
COPY tools/render-slates.sh tools/render-slates.sh
RUN bash tools/render-slates.sh /app/broadcaster/slate

ENV DATA_DIR=/data
VOLUME ["/data"]

WORKDIR /app/broadcaster

# The control dashboard (CONTROL_ENABLED=1) binds 127.0.0.1:3310 by default; run with
# network_mode: host and put Caddy/SSH in front — see deploy/ and docs/operator-guide.md.
CMD ["node", "src/index.js"]
