# Aliran repeater — keyless ciphertext mirror. Pure I/O: no ffmpeg, no crypto keys,
# no inbound ports needed for P2P (outbound UDP; network_mode: host recommended so
# hole-punching is not degraded by bridge NAT).
# BUILD FROM THE REPO ROOT (consistent with the panel/broadcaster images):
#   docker build -f repeater/Dockerfile -t aliran-repeater .
# deploy/docker-compose.repeater.yml already does this.
FROM node:24-bookworm-slim

WORKDIR /app

COPY repeater/package.json repeater/
RUN cd repeater && npm install --omit=dev

COPY repeater/src repeater/src

ENV DATA_DIR=/data
VOLUME ["/data"]

WORKDIR /app/repeater

CMD ["node", "src/index.js"]
