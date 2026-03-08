#!/bin/bash
# =============================================================
# BIN Card API - Quick Deploy Script
# 
# Deploy updates to VPS via SSH
# Usage: ./scripts/deploy.sh user@your-vps-ip
# =============================================================

set -euo pipefail

REMOTE="${1:-}"
APP_DIR="/opt/api-bin-card"
APP_NAME="api-bin-card"

if [ -z "$REMOTE" ]; then
  echo "Usage: ./scripts/deploy.sh user@your-vps-ip"
  echo ""
  echo "Examples:"
  echo "  ./scripts/deploy.sh root@123.45.67.89"
  echo "  ./scripts/deploy.sh deploy@myserver.com"
  exit 1
fi

echo "🚀 Deploying to ${REMOTE}..."

# Sync files (exclude data, node_modules, git)
echo "📦 Syncing files..."
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='data/*.db' \
  --exclude='data/*.db-wal' \
  --exclude='data/*.db-shm' \
  --exclude='data/cache' \
  --exclude='data/*.log' \
  --exclude='.git' \
  --exclude='*.lockb' \
  ./ "${REMOTE}:${APP_DIR}/"

# Install deps & restart
echo "🔧 Installing dependencies & restarting..."
ssh "$REMOTE" bash -s << 'EOF'
  cd /opt/api-bin-card
  bun install --production
  
  # Seed if database doesn't exist
  if [ ! -f "data/bin.db" ]; then
    echo "📥 Seeding database..."
    bun run src/scripts/seed.ts
  fi
  
  # Restart service
  systemctl restart api-bin-card
  
  # Wait and check health
  sleep 2
  curl -sf http://localhost:3000/health && echo "" || echo "⚠️ Health check failed"
EOF

echo "✅ Deploy complete!"
echo "   Check: ssh ${REMOTE} 'systemctl status ${APP_NAME}'"
