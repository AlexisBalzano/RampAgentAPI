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

# Install git for runtime updates
RUN apk add --no-cache git

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Copy config from the fetcher stage
COPY --from=config-fetcher /tmp/config-repo ./data

# Create a script for updating config
RUN echo '#!/bin/sh\ncd /app/data && git pull origin main' > /app/update-config.sh && \
    chmod +x /app/update-config.sh

EXPOSE 3000

CMD ["node", "index.js"]
