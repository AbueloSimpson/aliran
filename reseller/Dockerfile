# Aliran reseller panel — standalone HTTP service that fronts the panel admin API
# with a role hierarchy + credit ledger. No ffmpeg, no P2P: it only speaks HTTP to
# PANEL_ADMIN_URL (which may be another machine).
# BUILD FROM THE REPO ROOT (the image needs the @aliran/core workspace package):
#   docker build -f reseller/Dockerfile -t aliran-reseller .
# docker-compose.yml already does this (context: ., dockerfile: reseller/Dockerfile —
# the service sits behind the `reseller` compose profile: operators who don't run it
# simply never start it).
FROM node:24-bookworm-slim

WORKDIR /app

# @aliran/core is an unpublished workspace package, vendored into the image and
# resolved via the file:../core dependency. Install core's own deps first.
COPY core/ core/
COPY reseller/package.json reseller/
RUN cd core && npm install --omit=dev \
 && cd ../reseller && npm install --omit=dev

COPY reseller/src reseller/src
COPY reseller/control-ui reseller/control-ui

# Principals, ledger, account registry, cached panel token — all under /data.
ENV DATA_DIR=/data
VOLUME ["/data"]

WORKDIR /app/reseller

# The control dashboard binds 127.0.0.1:3330 by default; run with network_mode:
# host and put Caddy/SSH in front — see deploy/ and docs/reseller-panel.md. Seed the
# root admin on first run:
#   docker compose --profile reseller run --rm reseller node src/reseller-cli.js add-admin <name>
CMD ["node", "src/index.js"]
