import { Hono } from "hono";
import { lookupBin, searchBins, getStats } from "../db/queries";

const binRoutes = new Hono();

/**
 * GET /api/bin/:bin
 * Lookup a single BIN (6-8 digits)
 */
binRoutes.get("/:bin", (c) => {
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

  // Try exact match first (8 digits), then try truncated versions
  let result = null;
  const padded = binParam.padEnd(8, "0");

  // Try 8-digit match first
  result = lookupBin(padded);

  // If no match, try 6-digit prefix match
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

  return c.json({
    success: true,
    data: result,
    latency_ms: latency,
  });
});

/**
 * GET /api/bin/search
 * Search BINs with filters
 * Query params: brand, type, country, issuer, limit, offset
 */
binRoutes.get("/", (c) => {
  const start = performance.now();

  const brand = c.req.query("brand");
  const type = c.req.query("type");
  const country = c.req.query("country");
  const issuer = c.req.query("issuer");
  const limit = parseInt(c.req.query("limit") || "50");
  const offset = parseInt(c.req.query("offset") || "0");

  const result = searchBins({ brand, type, country, issuer, limit, offset });
  const latency = +(performance.now() - start).toFixed(3);

  return c.json({
    success: true,
    data: result.data,
    pagination: {
      total: result.total,
      limit,
      offset,
      has_more: offset + limit < result.total,
    },
    latency_ms: latency,
  });
});

export default binRoutes;
