import { Hono } from "hono";
import { getStats } from "../db/queries";

const statsRoutes = new Hono();

/**
 * GET /api/stats
 * Get database statistics
 */
statsRoutes.get("/", (c) => {
  const start = performance.now();
  const stats = getStats();
  const latency = +(performance.now() - start).toFixed(3);

  return c.json({
    success: true,
    data: stats,
    latency_ms: latency,
  });
});

export default statsRoutes;
