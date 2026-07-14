FROM node:18-slim

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including packages required to build sqlite3 if native build fails)
RUN apt-get update && apt-get install -y python3 make g++ unzip && rm -rf /var/lib/apt/lists/*
RUN npm install --omit=dev

# Copy rest of the code
COPY . .

# Expose port
EXPOSE 3000

# Run server
CMD ["node", "server.js"]
