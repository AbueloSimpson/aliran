# Aliran EPG — standalone program-guide service. No ffmpeg, no inbound ports for
# P2P (outbound UDP; network_mode: host recommended so hole-punching is not degraded
# by bridge NAT).
# BUILD FROM THE REPO ROOT (the image needs the @aliran/core workspace package):
#   docker build -f epg/Dockerfile -t aliran-epg .
# docker-compose.yml already does this (context: ., dockerfile: epg/Dockerfile — the
# service sits behind the `epg` compose profile: operators who don't publish a P2P
# guide simply never start it).
FROM node:24-bookworm-slim

WORKDIR /app

# @aliran/core is an unpublished workspace package, vendored into the image and
# resolved via the file:../core dependency. Install core's own deps first.
COPY core/ core/
COPY epg/package.json epg/
RUN cd core && npm install --omit=dev \
 && cd ../epg && npm install --omit=dev

COPY epg/src epg/src

# The corestore (epoch drives + the catalog replica) and epoch.json live under /data.
# Disk is bounded by the epoch rotation (~tens of MiB steady state).
ENV DATA_DIR=/data
VOLUME ["/data"]

WORKDIR /app/epg

CMD ["node", "src/index.js"]
