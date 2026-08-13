FROM node:22-slim

WORKDIR /app

# Native modules (better-sqlite3, sqlite3) compile via node-gyp during install, which needs
# Python 3 and a C/C++ toolchain. The slim base image lacks them, so install them before
# npm ci. (node:22-slim floated to a Node version with no prebuilt better-sqlite3 binary,
# so it falls back to compiling from source.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy package files & install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source and pre-built frontend static assets
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
