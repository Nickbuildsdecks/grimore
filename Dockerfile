FROM node:22-slim

WORKDIR /app

# Copy package files & install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source and pre-built frontend static assets
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
