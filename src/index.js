/**
 * BanasUno backend – Express API with Redis.
 * Health facilities (Davao City) are served from Redis; seed with npm run seed:facilities.
 */

import "dotenv/config";
import express from "express";
import { redis } from "./lib/redis.js";
import { pingSupabase } from "./lib/supabase.js";
import healthFacilities from "./routes/healthFacilities.js";
import heat from "./routes/heat.js";

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: in production set CORS_ORIGIN to your frontend origin (e.g. https://app.example.com). Unset = * (dev-friendly).
const corsOrigin = process.env.CORS_ORIGIN?.trim() || "*";

app.use(express.json());

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", corsOrigin);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-pipeline-report-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/api", healthFacilities);
app.use("/api", heat);

app.get("/api", (req, res) => {
  res.json({
    name: "BanasUno Backend",
    version: "1.0",
    endpoints: {
      "GET /api/facilities": "List Davao health facilities (query: type, source, ownership, name, limit, offset)",
      "GET /api/facilities/:id": "Get one facility by id",
      "GET /api/facilities/by-barangay/:barangayId": "Facilities assigned to barangay by nearest barangay lat/lon only",
      "POST /api/facilities/counts-by-barangays": "Batch facility counts for many barangay IDs (body: { barangayIds: [] }, for AI pipeline)",
      "GET /api/types": "Facility type summary",
      "GET /api/heat/:cityId/barangay-temperatures": "Barangay temperatures for heat map (cityId: davao)",
      "GET /api/heat/:cityId/barangay-heat-risk": "Barangay temperatures + heuristic heat-risk assessment (optional ?limit=)",
      "GET /api/heat/:cityId/forecast": "7- or 14-day forecast from WeatherAPI (cityId: davao, query: ?days=7|14)",
      "GET /api/heat/:cityId/barangay-population": "Population and density per barangay (PSA + GeoJSON area) for AI pipeline (cityId: davao)",
      "GET /api/heat/:cityId/pipeline-report/meta": "Disclaimer, sources, validity, updatedAt for pipeline report (for UI)",
      "GET /api/heat/:cityId/pipeline-report": "Download latest pipeline heat-risk report CSV (cityId: davao); 404 if none uploaded",
      "POST /api/heat/:cityId/pipeline-report/generate": "Generate pipeline report on demand (heat + facilities + density, K-Means); then download via GET pipeline-report",
      "POST /api/heat/:cityId/pipeline-report": "Upload pipeline report CSV (body: text/csv; optional x-pipeline-report-key if PIPELINE_REPORT_WRITER_KEY set)",
    },
  });
});

app.get("/health", async (req, res) => {
  const health = { status: "ok", redis: null, supabase: null };
  try {
    await redis.ping();
    health.redis = "connected";
  } catch (e) {
    health.status = "error";
    health.redis = "disconnected";
  }
  const supabasePing = await pingSupabase();
  if (supabasePing.ok) {
    health.supabase = "connected";
  } else if (supabasePing.error === "not_configured") {
    health.supabase = "not_configured";
  } else {
    health.supabase = "error";
    health.supabase_error = supabasePing.error;
    health.status = "error"; // configured but failed → unhealthy
  }
  const statusCode = health.status === "ok" ? 200 : 503;
  res.status(statusCode).json(health);
});

app.listen(PORT, () => {
  console.log(`BanasUno backend: http://localhost:${PORT}`);
  console.log(`  GET /api/facilities, /api/facilities/:id, /api/types, /api/heat/:cityId/barangay-temperatures, /api/heat/:cityId/barangay-heat-risk, /api/heat/:cityId/forecast`);
});
