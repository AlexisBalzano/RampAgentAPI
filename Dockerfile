# Multi-stage build
FROM node:18-alpine AS config-fetcher

# Install git
RUN apk add --no-cache git

# Clone the config repository
ARG CONFIG_REPO_URL
ARG CONFIG_BRANCH=main
WORKDIR /tmp
RUN git clone --branch ${CONFIG_BRANCH} --depth 1 ${CONFIG_REPO_URL} config-repo

# Main application stage
FROM node:18-alpine

WORKDIR /app

# Install git
RUN apk add --no-cache git

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Create data directory
RUN mkdir -p ./data

# Create initialization script
COPY scripts/init-config.sh /app/init-config.sh
RUN chmod +x /app/init-config.sh

EXPOSE 3000

# Use init script that fetches config then starts the app
CMD ["/app/init-config.sh"]
