# Aliran panel — runs behind a firewall/NAT with no inbound ports (outbound UDP only).
# BUILD FROM THE REPO ROOT (the image needs the @aliran/core workspace package):
#   docker build -f panel/Dockerfile -t aliran-panel .
# docker-compose.yml already does this (context: ., dockerfile: panel/Dockerfile).
FROM node:24-bookworm-slim

WORKDIR /app

# @aliran/core is an unpublished workspace package, vendored into the image and
# resolved via the file:../core dependency. Install core's own deps first.
COPY core/ core/
COPY panel/package.json panel/
RUN cd core && npm install --omit=dev \
 && cd ../panel && npm install --omit=dev

COPY panel/src panel/src
COPY panel/admin-ui panel/admin-ui

# Persist keys + cores here; mount a volume so they survive restarts and get backed up.
ENV DATA_DIR=/data
VOLUME ["/data"]

WORKDIR /app/panel

# No EXPOSE needed — discovery/replication is P2P over the DHT (outbound only).
# The admin dashboard (ADMIN_ENABLED=1) binds 127.0.0.1:3210 by default; run with
# network_mode: host and put Caddy/SSH in front — see deploy/ and docs/operator-guide.md.
CMD ["node", "src/index.js"]
