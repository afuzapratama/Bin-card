#!/bin/bash
# =============================================================
# BIN Card API - VPS Setup Script v3.0
#
# Works on: Ubuntu 22.04+ / Debian 12+
# Supports: Fresh VPS, VPS with Docker nginx, VPS with standalone nginx
#
# Usage:
#   chmod +x setup-vps.sh && sudo ./setup-vps.sh
#   DOMAIN=bin.example.com sudo -E ./setup-vps.sh
# =============================================================

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[i]${NC} $1"; }
step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# ─── Configuration ────────────────────────────────────────────
APP_NAME="api-bin-card"
APP_DIR="/opt/${APP_NAME}"
APP_USER="binapi"
APP_PORT="${PORT:-3000}"
DOMAIN="${DOMAIN:-}"
REPO_URL="${REPO_URL:-https://github.com/afuzapratama/Bin-card.git}"
VPS_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '?.?.?.?')"

# Auto-detect project root (works from scripts/ or project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || echo "")"

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║    BIN Card API - VPS Setup Script v3.0      ║${NC}"
echo -e "${BLUE}║    IP: ${VPS_IP}                              ${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ─── Check root ───────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  err "Jalankan sebagai root: sudo ./setup-vps.sh"
fi

# =============================================================
# Step 1: System packages
# =============================================================
step "Step 1/7: System packages"
log "Updating packages..."
apt-get update -qq
apt-get install -y -qq curl wget git unzip sqlite3 \
  ca-certificates gnupg lsb-release > /dev/null 2>&1
log "System packages ready"

# =============================================================
# Step 2: Install Bun (system-wide, accessible by all users)
# =============================================================
step "Step 2/7: Install Bun"

install_bun() {
  # Install to /root/.bun first
  if [ ! -f "$HOME/.bun/bin/bun" ]; then
    log "Downloading Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi

  # COPY (not symlink!) to /usr/local/bin so all users can access
  # This avoids permission issues with /root/.bun
  cp -f "$HOME/.bun/bin/bun" /usr/local/bin/bun
  chmod 755 /usr/local/bin/bun

  # Verify
  if /usr/local/bin/bun --version &>/dev/null; then
    log "Bun $(/usr/local/bin/bun --version) installed at /usr/local/bin/bun"
  else
    err "Bun installation failed"
  fi
}

if command -v bun &>/dev/null; then
  # Ensure the binary is a real file (not broken symlink) and accessible
  if sudo -u nobody /usr/local/bin/bun --version &>/dev/null 2>&1; then
    log "Bun $(bun --version) already installed and accessible"
  else
    warn "Bun exists but not accessible by other users, fixing..."
    install_bun
  fi
else
  install_bun
fi

# =============================================================
# Step 3: Create app user
# =============================================================
step "Step 3/7: App user & directories"

if ! id "$APP_USER" &>/dev/null; then
  useradd -r -m -s /bin/bash "$APP_USER"
  log "Created user: ${APP_USER}"
else
  log "User ${APP_USER} already exists"
fi

# =============================================================
# Step 4: Setup application code
# =============================================================
step "Step 4/7: Application setup"
mkdir -p "$APP_DIR"

# Priority: local project > git clone
if [ -n "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/package.json" ]; then
  if [ "$(realpath "$PROJECT_DIR" 2>/dev/null)" != "$(realpath "$APP_DIR" 2>/dev/null)" ]; then
    log "Detected project at: ${PROJECT_DIR}"
    # Use rsync if available, fallback to cp
    if command -v rsync &>/dev/null; then
      rsync -a --exclude='node_modules' --exclude='data/*.db' \
        --exclude='data/*.db-wal' --exclude='data/*.db-shm' \
        "$PROJECT_DIR/" "$APP_DIR/"
    else
      cp -a "$PROJECT_DIR/"* "$APP_DIR/" 2>/dev/null || true
      cp -a "$PROJECT_DIR/".[!.]* "$APP_DIR/" 2>/dev/null || true
    fi
    log "Project copied to ${APP_DIR}"
  else
    log "Project already at ${APP_DIR}"
  fi
elif [ -d "$APP_DIR/.git" ]; then
  log "Pulling latest..."
  cd "$APP_DIR" && git pull
else
  log "Cloning from: ${REPO_URL}"
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

log "Installing dependencies..."
/usr/local/bin/bun install --production 2>&1 | tail -1

# Create data directory
mkdir -p data data/cache

# Seed database if not exists
if [ ! -f "data/bin.db" ]; then
  log "Seeding BIN database (this may take 1-2 minutes)..."
  /usr/local/bin/bun run src/scripts/seed.ts
  log "Database seeded!"
else
  log "Database exists ($(du -h data/bin.db | cut -f1))"
fi

# Set ownership
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
log "Application ready at ${APP_DIR}"

# =============================================================
# Step 5: Systemd service
# =============================================================
step "Step 5/7: Systemd service"

cat > /etc/systemd/system/${APP_NAME}.service << EOF
[Unit]
Description=BIN Card Lookup API
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure
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

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$APP_NAME" > /dev/null 2>&1
systemctl restart "$APP_NAME"

# Wait for service to start
sleep 2
if curl -sf http://localhost:${APP_PORT}/health > /dev/null 2>&1; then
  log "Service started! API running on port ${APP_PORT}"
else
  # Give it more time
  sleep 3
  if curl -sf http://localhost:${APP_PORT}/health > /dev/null 2>&1; then
    log "Service started! API running on port ${APP_PORT}"
  else
    warn "Service may have issues. Check: journalctl -u ${APP_NAME} -n 20"
  fi
fi

# =============================================================
# Step 6: Cron job (weekly data update)
# =============================================================
step "Step 6/7: Cron job"

cat > /etc/cron.d/${APP_NAME}-update << EOF
# Update BIN data every Sunday at 3 AM
0 3 * * 0 ${APP_USER} cd ${APP_DIR} && /usr/local/bin/bun run src/scripts/update.ts >> ${APP_DIR}/data/update.log 2>&1
EOF
chmod 644 /etc/cron.d/${APP_NAME}-update
log "Weekly update cron configured (Sunday 3 AM)"

# =============================================================
# Step 7: Reverse Proxy + SSL
# =============================================================
step "Step 7/7: Domain & SSL"

# ── Ask for domain ──
if [ -z "$DOMAIN" ]; then
  echo ""
  info "Arahkan domain ke IP VPS ini dulu:"
  info "  DNS A Record → ${VPS_IP}"
  echo ""
  read -rp "Masukkan domain (contoh: bin.example.com) atau Enter untuk skip: " DOMAIN
  echo ""
fi

setup_domain() {
  if [ -z "$DOMAIN" ]; then
    warn "Skip domain setup."
    info "API bisa diakses via: http://${VPS_IP}:${APP_PORT}"
    return 0
  fi

  log "Setting up domain: ${DOMAIN}"

  # ── Detect what's on port 80 ──
  PORT80_PID=""
  PORT80_PROCESS=""
  DOCKER_NGINX_NAME=""
  DOCKER_NGINX_CONF=""
  CERTBOT_WEBROOT=""

  if ss -tlnp 2>/dev/null | grep -q ':80 '; then
    PORT80_PROCESS="$(ss -tlnp | grep ':80 ' | head -1 | grep -oP '\"[^\"]+\"' | head -1 | tr -d '"' || echo 'unknown')"

    # Check if it's Docker
    if echo "$PORT80_PROCESS" | grep -q 'docker-proxy'; then
      info "Port 80 dipakai Docker container"

      # Find which container
      DOCKER_NGINX_NAME="$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | grep ':80->' | awk '{print $1}' || echo '')"

      if [ -n "$DOCKER_NGINX_NAME" ]; then
        info "Container: ${DOCKER_NGINX_NAME}"

        # Find nginx config mount path on host
        DOCKER_NGINX_CONF="$(docker inspect "$DOCKER_NGINX_NAME" --format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/conf.d"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || echo '')"

        # Find certbot webroot mount
        CERTBOT_WEBROOT="$(docker inspect "$DOCKER_NGINX_NAME" --format '{{range .Mounts}}{{if eq .Destination "/var/www/certbot"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || echo '')"

        # Find letsencrypt mount
        LETSENCRYPT_DIR="$(docker inspect "$DOCKER_NGINX_NAME" --format '{{range .Mounts}}{{if eq .Destination "/etc/letsencrypt"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || echo '')"
      fi
    else
      info "Port 80 dipakai: ${PORT80_PROCESS}"
    fi
  fi

  # ── Route A: Docker Nginx detected ──
  if [ -n "$DOCKER_NGINX_CONF" ] && [ -d "$DOCKER_NGINX_CONF" ]; then
    log "Menggunakan Docker Nginx yang sudah ada"
    info "Config: ${DOCKER_NGINX_CONF}"

    # Check if vhost already exists
    if grep -q "$DOMAIN" "$DOCKER_NGINX_CONF/default.conf" 2>/dev/null || \
       grep -q "$DOMAIN" "$DOCKER_NGINX_CONF/binapi.conf" 2>/dev/null; then
      warn "Domain ${DOMAIN} sudah ada di config, skip."
    else
      # Add vhost to separate file (cleaner than appending)
      cat > "$DOCKER_NGINX_CONF/binapi.conf" << NGINX
# ============================================
# BIN Card API — ${DOMAIN}
# Auto-generated by setup-vps.sh
# ============================================

server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://host.docker.internal:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 5s;
        proxy_send_timeout 10s;
        proxy_read_timeout 10s;
    }

    location /health {
        proxy_pass http://host.docker.internal:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
    }
}
NGINX
      log "Nginx vhost created: ${DOCKER_NGINX_CONF}/binapi.conf"
    fi

    # Reload Docker nginx
    if docker exec "$DOCKER_NGINX_NAME" nginx -t 2>&1 | grep -q 'successful'; then
      docker exec "$DOCKER_NGINX_NAME" nginx -s reload
      log "Docker Nginx reloaded"
    else
      warn "Nginx config error! Check: docker exec ${DOCKER_NGINX_NAME} nginx -t"
    fi

    # Test HTTP
    sleep 1
    if curl -sf "http://${DOMAIN}/health" > /dev/null 2>&1; then
      log "HTTP working: http://${DOMAIN}"
    else
      warn "HTTP belum jalan. Pastikan DNS A record ${DOMAIN} → ${VPS_IP}"
    fi

    # ── SSL for Docker nginx ──
    echo ""
    read -rp "Pasang SSL sekarang? (y/n): " DO_SSL
    if [[ "$DO_SSL" =~ ^[Yy] ]]; then
      # Install certbot if needed
      if ! command -v certbot &>/dev/null; then
        apt-get install -y -qq certbot > /dev/null 2>&1
      fi

      read -rp "Email untuk SSL: " SSL_EMAIL
      SSL_EMAIL="${SSL_EMAIL:-admin@${DOMAIN}}"

      if [ -n "$CERTBOT_WEBROOT" ]; then
        log "Requesting SSL via webroot..."
        if certbot certonly --webroot -w "$CERTBOT_WEBROOT" \
          -d "$DOMAIN" --agree-tos --email "$SSL_EMAIL" --non-interactive; then

          # Add HTTPS server block
          cat > "$DOCKER_NGINX_CONF/binapi-ssl.conf" << NGINXSSL
# ============================================
# BIN Card API — ${DOMAIN} (HTTPS)
# Auto-generated by setup-vps.sh
# ============================================

server {
    listen 443 ssl;
    server_name ${DOMAIN};
    http2 on;

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:BINSSL:10m;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    location / {
        proxy_pass http://host.docker.internal:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 5s;
        proxy_send_timeout 10s;
        proxy_read_timeout 10s;
    }

    location /health {
        proxy_pass http://host.docker.internal:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
    }
}
NGINXSSL

          # Update HTTP block to redirect to HTTPS
          cat > "$DOCKER_NGINX_CONF/binapi.conf" << NGINXREDIR
# BIN Card API — HTTP redirect to HTTPS
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
NGINXREDIR

          # Reload
          docker exec "$DOCKER_NGINX_NAME" nginx -t 2>/dev/null && \
            docker exec "$DOCKER_NGINX_NAME" nginx -s reload
          log "SSL berhasil! https://${DOMAIN}"
        else
          warn "SSL gagal. Pastikan DNS sudah pointing ke ${VPS_IP}"
          warn "Jalankan manual: certbot certonly --webroot -w ${CERTBOT_WEBROOT} -d ${DOMAIN}"
        fi
      else
        warn "Certbot webroot not found. Jalankan SSL manual."
      fi
    fi
    return 0
  fi

  # ── Route B: Port 80 free, install standalone Nginx ──
  if ! ss -tlnp 2>/dev/null | grep -q ':80 '; then
    log "Port 80 kosong, install Nginx standalone"

    apt-get install -y -qq nginx > /dev/null 2>&1

    cat > /etc/nginx/sites-available/${APP_NAME} << NGINX
# BIN Card API - ${DOMAIN}
limit_req_zone \$binary_remote_addr zone=binapi:10m rate=30r/s;

upstream bin_api_backend {
    server 127.0.0.1:${APP_PORT};
    keepalive 32;
}

server {
    listen 80;
    server_name ${DOMAIN};

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

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
        proxy_connect_timeout 5s;
        proxy_send_timeout 10s;
        proxy_read_timeout 10s;
    }

    location /health {
        proxy_pass http://bin_api_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
    }
}
NGINX

    ln -sf /etc/nginx/sites-available/${APP_NAME} /etc/nginx/sites-enabled/
    nginx -t 2>/dev/null && systemctl restart nginx
    log "Standalone Nginx configured"

    # SSL with certbot --nginx
    echo ""
    read -rp "Pasang SSL sekarang? (y/n): " DO_SSL
    if [[ "$DO_SSL" =~ ^[Yy] ]]; then
      apt-get install -y -qq certbot python3-certbot-nginx > /dev/null 2>&1
      read -rp "Email untuk SSL: " SSL_EMAIL
      SSL_EMAIL="${SSL_EMAIL:-admin@${DOMAIN}}"
      if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$SSL_EMAIL"; then
        log "SSL berhasil! https://${DOMAIN}"
      else
        warn "SSL gagal. Jalankan manual: certbot --nginx -d ${DOMAIN}"
      fi
    fi
    return 0
  fi

  # ── Route C: Port 80 used by unknown service ──
  warn "Port 80 dipakai oleh: ${PORT80_PROCESS}"
  warn "Tidak bisa auto-setup reverse proxy."
  echo ""
  info "API tetap jalan di: http://${VPS_IP}:${APP_PORT}"
  info "Tambahkan reverse proxy manual di web server yang sudah ada."
  info "Config yang dibutuhkan:"
  echo ""
  echo "  server_name ${DOMAIN};"
  echo "  proxy_pass http://127.0.0.1:${APP_PORT};"
  echo ""
}

setup_domain

# =============================================================
# Firewall (add rules, don't reset existing!)
# =============================================================
if command -v ufw &>/dev/null; then
  ufw allow ssh > /dev/null 2>&1 || true
  ufw allow "${APP_PORT}/tcp" > /dev/null 2>&1 || true
  ufw --force enable > /dev/null 2>&1 || true
  log "Firewall: port ${APP_PORT} allowed"
fi

# =============================================================
# Done!
# =============================================================
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Setup Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  API:      http://${VPS_IP}:${APP_PORT}"
if [ -n "$DOMAIN" ]; then
echo -e "  Domain:   https://${DOMAIN}"
fi
echo ""
echo -e "  Commands:"
echo -e "    systemctl status ${APP_NAME}"
echo -e "    journalctl -u ${APP_NAME} -f"
echo -e "    systemctl restart ${APP_NAME}"
echo ""

# Quick health check
if curl -sf http://localhost:${APP_PORT}/health > /dev/null 2>&1; then
  log "Health check passed!"
  curl -s http://localhost:${APP_PORT}/health | python3 -m json.tool 2>/dev/null || \
    curl -s http://localhost:${APP_PORT}/health
  echo ""
else
  warn "API belum jalan. Check: journalctl -u ${APP_NAME} -n 20"
fi
