#!/bin/bash
# =============================================================
# BIN Card API - VPS Setup Script
# 
# Supported OS: Ubuntu 22.04+ / Debian 12+
# Run as root: curl -sSL <url> | bash
# Or: chmod +x setup-vps.sh && sudo ./setup-vps.sh
# =============================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[i]${NC} $1"; }

# Configuration
APP_NAME="api-bin-card"
APP_DIR="/opt/${APP_NAME}"
APP_USER="binapi"
APP_PORT="${PORT:-3000}"
DOMAIN="${DOMAIN:-}"
REPO_URL="${REPO_URL:-https://github.com/afuzapratama/Bin-card.git}"

# Auto-detect project root (in case script is run from within the repo)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || echo "")"

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║    BIN Card API - VPS Setup Script       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

# Check root
if [ "$EUID" -ne 0 ]; then
  err "Please run as root (sudo ./setup-vps.sh)"
fi

# =============================================================
# Step 1: System update & essentials
# =============================================================
log "Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

log "Installing essentials..."
apt-get install -y -qq curl wget git unzip ufw fail2ban sqlite3 \
  ca-certificates gnupg lsb-release > /dev/null 2>&1

# =============================================================
# Step 2: Install Bun
# =============================================================
if ! command -v bun &> /dev/null; then
  log "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  # Make bun available system-wide
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
  log "Bun $(bun --version) installed"
else
  log "Bun $(bun --version) already installed"
fi

# =============================================================
# Step 3: Create app user
# =============================================================
if ! id "$APP_USER" &>/dev/null; then
  log "Creating user: ${APP_USER}"
  useradd -r -m -s /bin/bash "$APP_USER"
else
  log "User ${APP_USER} already exists"
fi

# =============================================================
# Step 4: Setup application
# =============================================================
log "Setting up application directory..."
mkdir -p "$APP_DIR"

# Detect if we're running from inside the cloned repo
if [ -n "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/package.json" ]; then
  if [ "$(realpath "$PROJECT_DIR")" != "$(realpath "$APP_DIR")" ]; then
    log "Detected project at: ${PROJECT_DIR}"
    log "Copying to ${APP_DIR}..."
    cp -a "$PROJECT_DIR/"* "$APP_DIR/" 2>/dev/null || true
    cp -a "$PROJECT_DIR/".* "$APP_DIR/" 2>/dev/null || true
  else
    log "Already running from ${APP_DIR}"
  fi
elif [ -n "$REPO_URL" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    log "Pulling latest from: ${REPO_URL}"
    cd "$APP_DIR" && git pull
  else
    log "Cloning from: ${REPO_URL}"
    git clone "$REPO_URL" "$APP_DIR"
  fi
else
  warn "No project found and no REPO_URL set."
  warn "Please copy your project to ${APP_DIR} manually."
fi

cd "$APP_DIR"

log "Installing dependencies..."
bun install --production

# Create data directory
mkdir -p data data/cache

# Seed database if not exists
if [ ! -f "data/bin.db" ]; then
  log "Seeding BIN database (downloading from GitHub)..."
  bun run src/scripts/seed.ts
  log "Database seeded!"
else
  log "Database already exists ($(du -h data/bin.db | cut -f1))"
fi

# Set ownership
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# =============================================================
# Step 5: Create systemd service
# =============================================================
log "Creating systemd service..."
cat > /etc/systemd/system/${APP_NAME}.service << EOF
[Unit]
Description=BIN Card Lookup API
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=${APP_PORT}

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data
PrivateTmp=true

# Resource limits
MemoryMax=512M
CPUQuota=100%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$APP_NAME"
systemctl restart "$APP_NAME"
log "Service started!"

# =============================================================
# Step 6: Create weekly update cron
# =============================================================
log "Setting up weekly data update cron..."
cat > /etc/cron.d/${APP_NAME}-update << EOF
# Update BIN data every Sunday at 3 AM
0 3 * * 0 ${APP_USER} cd ${APP_DIR} && /usr/local/bin/bun run src/scripts/update.ts >> ${APP_DIR}/data/update.log 2>&1
EOF
chmod 644 /etc/cron.d/${APP_NAME}-update

# =============================================================
# Step 7: Firewall setup
# =============================================================
log "Configuring firewall..."
ufw --force reset > /dev/null 2>&1
ufw default deny incoming > /dev/null 2>&1
ufw default allow outgoing > /dev/null 2>&1
ufw allow ssh > /dev/null 2>&1
ufw allow 80/tcp > /dev/null 2>&1
ufw allow 443/tcp > /dev/null 2>&1
ufw allow "$APP_PORT/tcp" > /dev/null 2>&1
ufw --force enable > /dev/null 2>&1
log "Firewall configured (SSH, HTTP, HTTPS, port ${APP_PORT})"

# =============================================================
# Step 8: Setup Nginx reverse proxy + SSL
# =============================================================
setup_nginx() {
  # Interactive domain prompt if not set via env
  if [ -z "$DOMAIN" ]; then
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Nginx Reverse Proxy + SSL Setup                 ║${NC}"
    echo -e "${BLUE}╠══════════════════════════════════════════════════╣${NC}"
    echo -e "${BLUE}║                                                  ║${NC}"
    echo -e "${BLUE}║  Arahkan domain/subdomain ke IP VPS ini dulu:    ║${NC}"
    echo -e "${BLUE}║    IP: $(hostname -I | awk '{print $1}')${NC}"
    echo -e "${BLUE}║                                                  ║${NC}"
    echo -e "${BLUE}║  Contoh DNS Record (di Cloudflare/registrar):    ║${NC}"
    echo -e "${BLUE}║    Type: A                                       ║${NC}"
    echo -e "${BLUE}║    Name: bin (atau api, atau @)                   ║${NC}"
    echo -e "${BLUE}║    Value: $(hostname -I | awk '{print $1}')${NC}"
    echo -e "${BLUE}║    Proxy: DNS only (grey cloud) untuk SSL         ║${NC}"
    echo -e "${BLUE}║                                                  ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
    echo ""
    read -rp "Masukkan domain (contoh: bin.example.com) atau tekan Enter untuk skip: " DOMAIN
    echo ""
  fi

  if [ -z "$DOMAIN" ]; then
    warn "Domain tidak diisi, skip Nginx setup."
    warn "API tetap bisa diakses via: http://$(hostname -I | awk '{print $1}'):${APP_PORT}"
    warn "Jalankan ulang dengan: DOMAIN=bin.example.com sudo -E ./scripts/setup-vps.sh"
    return 0
  fi

  log "Setting up Nginx for domain: ${DOMAIN}"

  # Install nginx & certbot if not installed
  if ! command -v nginx &> /dev/null; then
    log "Installing Nginx..."
    apt-get install -y -qq nginx > /dev/null 2>&1
  else
    log "Nginx already installed"
  fi

  # Create vhost config (does NOT touch default or other sites)
  cat > /etc/nginx/sites-available/${APP_NAME} << NGINX
# BIN Card API - ${DOMAIN}
# Rate limiting zone (unique name to avoid conflict)
limit_req_zone \$binary_remote_addr zone=binapi:10m rate=30r/s;

upstream bin_api_backend {
    server 127.0.0.1:${APP_PORT};
    keepalive 32;
}

server {
    listen 80;
    server_name ${DOMAIN};

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Gzip
    gzip on;
    gzip_types application/json;
    gzip_min_length 256;

    location / {
        limit_req zone=binapi burst=50 nodelay;

        proxy_pass http://bin_api_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # Timeouts
        proxy_connect_timeout 5s;
        proxy_send_timeout 10s;
        proxy_read_timeout 10s;
    }

    # Health check (no rate limit)
    location /health {
        proxy_pass http://bin_api_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
    }
}
NGINX

  # Enable site (tanpa hapus default atau site lain!)
  ln -sf /etc/nginx/sites-available/${APP_NAME} /etc/nginx/sites-enabled/

  # Test config before reload
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    log "Nginx vhost configured: http://${DOMAIN}"
  else
    err "Nginx config test failed! Check: nginx -t"
  fi

  # Setup SSL with Let's Encrypt
  log "Installing Certbot for SSL..."
  apt-get install -y -qq certbot python3-certbot-nginx > /dev/null 2>&1

  info "Requesting SSL certificate for ${DOMAIN}..."
  read -rp "Masukkan email untuk SSL (contoh: admin@gmail.com): " SSL_EMAIL
  SSL_EMAIL="${SSL_EMAIL:-admin@${DOMAIN}}"

  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$SSL_EMAIL" 2>/dev/null; then
    log "SSL berhasil! API ready di: https://${DOMAIN}"
  else
    warn "SSL gagal. Kemungkinan domain belum pointing ke IP ini."
    warn "Pastikan DNS A record ${DOMAIN} → $(hostname -I | awk '{print $1}')"
    warn "Lalu jalankan manual: certbot --nginx -d ${DOMAIN}"
    info "API tetap bisa diakses via: http://${DOMAIN}"
  fi
}

setup_nginx

# =============================================================
# Step 9: Setup fail2ban
# =============================================================
log "Configuring fail2ban..."
systemctl enable fail2ban > /dev/null 2>&1
systemctl start fail2ban > /dev/null 2>&1

# =============================================================
# Done!
# =============================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Setup Complete!                         ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                  ║${NC}"
echo -e "${GREEN}║  API running at:                                 ║${NC}"
echo -e "${GREEN}║    http://$(hostname -I | awk '{print $1}'):${APP_PORT}                        ║${NC}"
if [ -n "$DOMAIN" ]; then
echo -e "${GREEN}║    https://${DOMAIN}$(printf '%*s' $((36 - ${#DOMAIN})) '')║${NC}"
fi
echo -e "${GREEN}║                                                  ║${NC}"
echo -e "${GREEN}║  Commands:                                       ║${NC}"
echo -e "${GREEN}║    systemctl status ${APP_NAME}              ║${NC}"
echo -e "${GREEN}║    journalctl -u ${APP_NAME} -f             ║${NC}"
echo -e "${GREEN}║    systemctl restart ${APP_NAME}             ║${NC}"
if [ -n "$DOMAIN" ]; then
echo -e "${GREEN}║    certbot renew --dry-run  (test SSL renewal)    ║${NC}"
fi
echo -e "${GREEN}║                                                  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# Quick health check
sleep 2
if curl -sf http://localhost:${APP_PORT}/health > /dev/null 2>&1; then
  log "Health check passed! API is running."
  curl -s http://localhost:${APP_PORT}/health | python3 -m json.tool 2>/dev/null || true
else
  warn "API might still be starting up. Check: systemctl status ${APP_NAME}"
fi
