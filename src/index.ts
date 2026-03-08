import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { compress } from "hono/compress";
import { prettyJSON } from "hono/pretty-json";
import binRoutes from "./routes/bin";
import statsRoutes from "./routes/stats";
import { binCache } from "./middleware/cache";
import { rateLimiter } from "./middleware/ratelimit";
import { lookupBin } from "./db/queries";
import { getDb } from "./db/schema";

const app = new Hono();

// ============================================================
// Global Middleware
// ============================================================
app.use("*", cors());
app.use("*", compress());
app.use("*", prettyJSON());

// Logger (only in non-production for performance)
if (process.env.NODE_ENV !== "production") {
  app.use("*", logger());
}

// Rate limiting middleware
app.use("/api/*", async (c, next) => {
  const ip =
    c.req.header("x-forwarded-for") ||
    c.req.header("x-real-ip") ||
    c.req.header("cf-connecting-ip") ||
    "unknown";

  const result = rateLimiter.consume(ip);

  c.header("X-RateLimit-Remaining", result.remaining.toString());
  c.header("X-RateLimit-Reset", result.resetMs.toString());

  if (!result.allowed) {
    return c.json(
      {
        success: false,
        message: "Rate limit exceeded. Please slow down.",
        retry_after_ms: result.resetMs,
      },
      429
    );
  }

  await next();
});

// ============================================================
// Routes
// ============================================================

// Health check
app.get("/", (c) => {
  return c.json({
    name: "BIN Card Lookup API",
    version: "1.0.0",
    description: "Free BIN/IIN lookup API for credit/debit card identification",
    endpoints: {
      lookup: "GET /api/bin/:bin",
      search: "GET /api/bin?brand=VISA&country=US&type=credit",
      stats: "GET /api/stats",
      health: "GET /health",
    },
    source: "https://github.com/your-repo/api-bin-card",
  });
});

app.get("/health", (c) => {
  try {
    const db = getDb();
    const result = db.prepare("SELECT COUNT(*) as total FROM bins").get() as any;
    return c.json({
      status: "healthy",
      database: "connected",
      total_bins: result.total,
      cache_size: binCache.size,
      uptime: process.uptime(),
    });
  } catch (e: any) {
    return c.json({ status: "unhealthy", error: e.message }, 500);
  }
});

// Fast BIN lookup with cache layer
app.get("/api/bin/:bin", (c) => {
  const start = performance.now();
  const binParam = c.req.param("bin").replace(/\D/g, "");

  if (binParam.length < 6 || binParam.length > 8) {
    return c.json(
      {
        success: false,
        data: null,
        message: "BIN must be 6-8 digits",
        latency_ms: +(performance.now() - start).toFixed(3),
      },
      400
    );
  }

  // Check cache first
  const cacheKey = binParam.substring(0, 8);
  const cached = binCache.get(cacheKey);
  if (cached !== undefined) {
    return c.json({
      success: true,
      data: cached,
      cached: true,
      latency_ms: +(performance.now() - start).toFixed(3),
    });
  }

  // Database lookup
  let result = null;
  const padded = binParam.padEnd(8, "0");
  result = lookupBin(padded);

  if (!result && binParam.length >= 6) {
    const sixDigit = binParam.substring(0, 6).padEnd(8, "0");
    result = lookupBin(sixDigit);
  }

  const latency = +(performance.now() - start).toFixed(3);

  if (!result) {
    return c.json(
      {
        success: false,
        data: null,
        message: `BIN ${binParam} not found`,
        latency_ms: latency,
      },
      404
    );
  }

  // Store in cache
  binCache.set(cacheKey, result);

  return c.json({
    success: true,
    data: result,
    cached: false,
    latency_ms: latency,
  });
});

// Search and Stats routes
app.route("/api/bin", binRoutes);
app.route("/api/stats", statsRoutes);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      success: false,
      message: "Endpoint not found. Visit / for API documentation.",
    },
    404
  );
});

// Error handler
app.onError((err, c) => {
  console.error("Server error:", err);
  return c.json(
    {
      success: false,
      message: "Internal server error",
    },
    500
  );
});

// ============================================================
// Server Start
// ============================================================
const PORT = parseInt(process.env.PORT || "3000");

console.log(`
╔══════════════════════════════════════════╗
║       BIN Card Lookup API v1.0.0        ║
╠══════════════════════════════════════════╣
║  🌐 http://localhost:${PORT}               ║
║  📖 GET /                  → API docs   ║
║  🔍 GET /api/bin/:bin      → Lookup     ║
║  🔎 GET /api/bin?brand=... → Search     ║
║  📊 GET /api/stats         → Stats      ║
║  💚 GET /health            → Health     ║
╚══════════════════════════════════════════╝
`);

export default {
  port: PORT,
  fetch: app.fetch,
};
