# BIN Card Lookup API

Fast, free BIN/IIN lookup API with **449,000+ card records** from multiple open-source datasets. Built with **Bun + Hono + SQLite** for sub-millisecond cached lookups.

## Quick Start

```bash
# Install dependencies
bun install

# Seed database (downloads & merges 4 free data sources)
bun run seed

# Start development server
bun run dev

# Production
bun run start
```

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | API documentation |
| `GET /health` | Health check + stats |
| `GET /api/bin/:bin` | Lookup BIN (6-8 digits) |
| `GET /api/bin?brand=VISA&country=US` | Search with filters |
| `GET /api/stats` | Database statistics |

### Lookup Example

```bash
curl http://localhost:3000/api/bin/457173
```

```json
{
  "success": true,
  "data": {
    "bin": "45717300",
    "brand": "VISA",
    "type": "debit",
    "category": "CLASSIC",
    "issuer": "PBS INTERNATIONAL A/S",
    "issuer_phone": "+45 44 68 44 68",
    "country_alpha2": "DK",
    "country_name": "Denmark",
    "country_iso3": "DNK",
    "currency": "DKK",
    "is_prepaid": false
  },
  "cached": false,
  "latency_ms": 0.12
}
```

### Search Filters

```bash
# By brand
curl "http://localhost:3000/api/bin?brand=VISA&limit=10"

# By country
curl "http://localhost:3000/api/bin?country=US&type=credit"

# By issuer
curl "http://localhost:3000/api/bin?issuer=BANK+OF+AMERICA"
```

## Data Sources (All FREE)

The seed script aggregates and merges data from 4 open-source repositories:

| Source | Records | Notes |
|---|---|---|
| [Bes-js/binfo](https://github.com/Bes-js/binfo) | ~369,000 | Most complete, includes currency & phone |
| [iannuttall/binlist-data](https://github.com/iannuttall/binlist-data) | ~343,000 | Large CSV dataset (archived 2020) |
| [binlist/data](https://github.com/binlist/data) | ~5,800 | High quality, 651+ stars |
| ISO/IEC 7812 known ranges | ~25 | Standard BIN prefixes |

After merge & dedup: **449,965 unique BINs** with field-level COALESCE (best data wins).

## Updating Data

```bash
# Auto-update from GitHub sources
bun run update-data

# Import your own CSV
bun run import-csv path/to/your-data.csv

# Crontab (weekly update)
0 3 * * 0 cd /path/to/api-bin-card && bun run update-data >> data/update.log 2>&1
```

## Deployment

### Option 1: Docker (Recommended)

```bash
# Build and run
docker compose up -d

# Or build manually
docker build -t api-bin-card .
docker run -d -p 3000:3000 -v bin-data:/app/data api-bin-card
```

### Option 2: VPS One-Click Setup

Automated setup for Ubuntu/Debian VPS (installs Bun, Nginx, SSL, systemd):

```bash
# Clone to VPS
git clone <your-repo-url> /opt/api-bin-card
cd /opt/api-bin-card

# Run setup (as root)
chmod +x scripts/setup-vps.sh
sudo ./setup-vps.sh
```

What the setup script does:
- Installs Bun, Nginx, fail2ban, UFW firewall
- Creates a `binapi` system user
- Seeds the database (449K BINs)
- Configures systemd service with security hardening
- Sets up Nginx reverse proxy with rate limiting
- Configures Let's Encrypt SSL (if `DOMAIN` env is set)
- Adds weekly cron for data updates

```bash
# With custom domain and SSL
DOMAIN=api.example.com sudo -E ./scripts/setup-vps.sh
```

### Option 3: Deploy Updates

Push updates to a running VPS:

```bash
./scripts/deploy.sh root@your-vps-ip
```

### Useful Commands (after setup)

```bash
# Service management
systemctl status api-bin-card
systemctl restart api-bin-card
journalctl -u api-bin-card -f    # live logs

# Update data manually
cd /opt/api-bin-card && bun run update-data
```

### Recommended VPS

| Provider | Plan | Price | Specs |
|---|---|---|---|
| Hetzner | CX22 | ~€4/mo | 2 vCPU, 4GB RAM, 40GB NVMe |
| Hetzner | CX11 | ~€3.5/mo | 1 vCPU, 2GB RAM, 20GB NVMe |

The API uses ~50MB RAM idle and the database is ~40MB. Even the smallest VPS is more than enough.

## Performance

- **Cached lookup**: ~0.05ms (LRU cache, 50K entries)
- **DB lookup**: ~0.5ms (SQLite WAL mode + prepared statements)
- **Search**: ~5-30ms depending on filters
- **Database size**: ~40MB for 449K records

## Stack

- **Runtime**: [Bun](https://bun.com) (faster than Node.js)
- **Framework**: [Hono](https://hono.dev) (ultrafast web framework)
- **Database**: bun:sqlite (built-in, WAL mode, 64MB cache)
- **Cache**: In-memory LRU (50K entries)
- **Rate Limit**: Token bucket (100 req burst, 20/sec refill)
- **Deploy**: Docker / systemd + Nginx

## Project Structure

```
├── src/
│   ├── index.ts              # Main app entry point
│   ├── types/bin.ts          # TypeScript interfaces
│   ├── db/
│   │   ├── schema.ts         # SQLite schema & init
│   │   └── queries.ts        # Prepared statements
│   ├── routes/
│   │   ├── bin.ts            # BIN lookup & search
│   │   └── stats.ts          # Statistics endpoint
│   ├── middleware/
│   │   ├── cache.ts          # LRU cache
│   │   └── ratelimit.ts      # Token bucket limiter
│   └── scripts/
│       ├── seed.ts           # Multi-source data seeder
│       ├── update.ts         # Auto-updater for cron
│       └── import-csv.ts     # CSV import tool
├── scripts/
│   ├── setup-vps.sh          # VPS one-click setup
│   └── deploy.sh             # Quick deploy via SSH
├── Dockerfile                # Multi-stage build
├── docker-compose.yml        # Docker Compose config
└── data/
    └── bin.db                # SQLite database (generated)
```

## License

MIT
