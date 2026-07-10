# Aliran panel — runs behind a firewall/NAT with no inbound ports (outbound UDP only).
FROM node:20-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Persist keys + cores here; mount a volume so they survive restarts and get backed up.
ENV DATA_DIR=/data
VOLUME ["/data"]

# No EXPOSE needed — discovery/replication is P2P over the DHT (outbound only).
CMD ["node", "src/index.js"]
