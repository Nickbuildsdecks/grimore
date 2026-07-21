FROM node:22-slim AS web-build

WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/src ./src
COPY web/public ./public
COPY web/index.html ./
COPY web/vite.config.ts ./
COPY web/tsconfig*.json ./
RUN npx tsc -b && npx vite build

FROM node:22-slim

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including packages required to build sqlite3 if native build fails)
RUN apt-get update && apt-get install -y python3 make g++ unzip && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev

# Copy rest of the code
COPY . .
COPY --from=web-build /app/web/dist ./web/dist

# Expose port
EXPOSE 3000

# Run server
CMD ["node", "server.js"]
