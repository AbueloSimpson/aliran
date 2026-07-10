# Aliran broadcaster — needs ffmpeg. No inbound ports for P2P (outbound UDP);
# only expose RTMP if you use OBS push (INPUT=rtmp).
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

ENV DATA_DIR=/data
VOLUME ["/data"]

# Uncomment if using OBS RTMP push (INPUT=rtmp):
# EXPOSE 1935

CMD ["node", "src/index.js"]
