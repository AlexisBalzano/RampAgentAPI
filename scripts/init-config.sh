#!/bin/sh

CONFIG_REPO_URL=${CONFIG_REPO_URL:-"https://github.com/vaccfr/RampAgent-Config.git"}
CONFIG_BRANCH=${CONFIG_BRANCH:-"main"}

echo "🔄 Fetching config from $CONFIG_REPO_URL..."

# Ensure data directory is writable
mkdir -p /app/data
chmod 755 /app/data

# Check if data directory exists and has git repo
if [ -d "/app/data/.git" ]; then
    echo "📝 Updating existing config..."
    cd /app/data && git pull origin $CONFIG_BRANCH
else
    echo "📁 Cloning config repository..."
    # Use a temporary directory first
    rm -rf /tmp/config-temp
    git clone --branch $CONFIG_BRANCH $CONFIG_REPO_URL /tmp/config-temp
    
    # Copy to data directory
    cp -r /tmp/config-temp/* /app/data/
    cp -r /tmp/config-temp/.git /app/data/
    
    # Cleanup
    rm -rf /tmp/config-temp
fi

if [ $? -eq 0 ]; then
    echo "✅ Config updated successfully!"
    echo "📂 Config files:"
    ls -la /app/data/
else
    echo "❌ Config update failed!"
    exit 1
fi

echo "🚀 Starting application..."
exec node index.js