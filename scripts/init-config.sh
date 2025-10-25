#!/bin/sh

CONFIG_REPO_URL=${CONFIG_REPO_URL:-"https://github.com/vaccfr/RampAgent-Config.git"}
CONFIG_BRANCH=${CONFIG_BRANCH:-"main"}

echo "Fetching config from $CONFIG_REPO_URL..."

# Check if data directory exists and has git repo
if [ -d "/app/data/.git" ]; then
    echo "Updating existing config..."
    cd /app/data && git pull origin $CONFIG_BRANCH
else
    echo "Cloning config repository..."
    rm -rf /app/data/*
    git clone --branch $CONFIG_BRANCH $CONFIG_REPO_URL /app/data
fi

echo "Config updated. Starting application..."
exec node index.js