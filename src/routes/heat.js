/**
 * Heat / barangay temperatures API.
 * - Meteosource (METEOSOURCE_API_KEY): required for different heat temps per barangay. Fetches per-barangay temp by centroid; heat-risk varies by barangay.
 * - WeatherAPI only (WEATHER_API_KEY, no Meteosource): fallback—single city average applied to all barangays; same temp and risk for every barangay.
 */

import express from "express";
import { Router } from "express";
import {
  getCurrentWeather as getWeatherWeatherAPI,
  getForecast as getWeatherForecast,
} from "../services/weatherService.js";
import { getCurrentWeather as getWeatherMeteosource } from "../services/meteosourceService.js";
import { getDavaoBarangayGeo, getBarangayCentroids } from "../lib/barangays.js";
import { getPopulationDensityByBarangayId } from "../lib/populationByBarangay.js";
import { assessBarangayHeatRisk } from "../services/heatRiskModel.js";
import { redis } from "../lib/redis.js";
import { FACILITIES_KEY, PIPELINE_REPORT_KEY, PIPELINE_REPORT_UPDATED_KEY } from "../lib/constants.js";
import { assessFacilitiesInBarangay } from "../services/facilitiesByBarangay.js";
import { runPipelineReport } from "../services/pipelineReportGenerator.js";
import {
  FORECAST_DISCLAIMER,
  FORECAST_SOURCES,
  FORECAST_VALIDITY,
  HEAT_RISK_DISCLAIMER,
  HEAT_RISK_SOURCES,
  HEAT_RISK_VALIDITY,
  PIPELINE_REPORT_DISCLAIMER,
  PIPELINE_REPORT_SOURCES,
  PIPELINE_REPORT_VALIDITY,
  TEMPERATURES_DISCLAIMER,
  TEMPERATURES_SOURCES,
  TEMPERATURES_VALIDITY,
} from "../lib/disclaimers.js";

/** Davao City center for WeatherAPI average temp (lat, lon) */
const DAVAO_CENTER = "7.1907,125.4553";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_KEY_AVG = "davao_avg";
const CACHE_KEY_FORECAST_7 = "davao_forecast_7";
const CACHE_KEY_FORECAST_14 = "davao_forecast_14";
/** Parallel Meteosource requests. Lower to avoid rate limits (e.g. METEOSOURCE_CONCURRENCY=3). */
const CONCURRENCY = Math.max(1, Math.min(20, parseInt(process.env.METEOSOURCE_CONCURRENCY, 10) || 5));
/** Optional ms to wait before each uncached Meteosource request (e.g. 200) to spread load and avoid rate limits. */
const METEOSOURCE_DELAY_MS = Math.max(0, parseInt(process.env.METEOSOURCE_DELAY_MS, 10) || 0);

const router = Router();

/** Cache: "lat,lng" (2 decimals) -> { temp_c, humidity?, ts } for Meteosource; CACHE_KEY_AVG -> { temp_c, ts } for WeatherAPI */
const weatherCache = new Map();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function cacheKey(lat, lng) {
  return `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
}

async function runWithConcurrency(items, fn) {
  const results = new Map();
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const item = items[index++];
      const temp = await fn(item);
      if (item.key != null && temp != null) results.set(item.key, temp);
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * GET /api/heat/:cityId/barangay-population
 * Returns { [barangayId]: { population, density } } for pipeline (PSA census + GeoJSON area).
 */
router.get("/heat/:cityId/barangay-population", async (req, res) => {
  const cityId = (req.params.cityId || "").toLowerCase();
  if (cityId !== "davao") {
    return res.status(404).json({ error: "City not supported", cityId });
  }
  try {
    const map = await getPopulationDensityByBarangayId();
    return res.json(map);
  } catch (err) {
    console.error("Barangay population error:", err);
    return res.status(500).json({ error: "Failed to load population data" });
  }
});

/** TTL for pipeline report in Redis (7 days). */
const PIPELINE_REPORT_TTL_SEC = 604800;

/**
 * GET /api/heat/:cityId/pipeline-report/meta
 * Returns disclaimer, sources, validity, and updatedAt for the pipeline report (for display when offering download).
 */
router.get("/heat/:cityId/pipeline-report/meta", async (req, res) => {
  const cityId = (req.params.cityId || "").toLowerCase();
  if (cityId !== "davao") {
    return res.status(404).json({ error: "City not supported", cityId });
  }
  try {
    const updatedAt = await redis.get(PIPELINE_REPORT_UPDATED_KEY);
    const available = await redis.get(PIPELINE_REPORT_KEY);
    return res.json({
      available: available != null && available !== "",
      updatedAt: updatedAt || null,
      disclaimer: PIPELINE_REPORT_DISCLAIMER,
      sources: PIPELINE_REPORT_SOURCES,
      validity: PIPELINE_REPORT_VALIDITY,
      docs: "docs/DISCLAIMERS.md",
    });
  } catch (err) {
    console.error("Pipeline report meta error:", err);
    return res.status(500).json({ error: "Failed to load pipeline report meta" });
  }
});

/**
 * GET /api/heat/:cityId/pipeline-report
 * Returns the latest pipeline heat-risk report CSV for download (stored in Redis by pipeline script).
 * Frontend can link or fetch this URL and trigger a file download.
 */
router.get("/heat/:cityId/pipeline-report", async (req, res) => {
  const cityId = (req.params.cityId || "").toLowerCase();
  if (cityId !== "davao") {
    return res.status(404).json({ error: "City not supported", cityId });
  }
  try {
    const csv = await redis.get(PIPELINE_REPORT_KEY);
    if (csv == null || csv === "") {
      return res.status(404).json({
        error: "No pipeline report available",
        hint: "Run the AI pipeline and upload the report (POST with x-pipeline-report-key), or wait for the next scheduled run.",
      });
    }
    const updated = await redis.get(PIPELINE_REPORT_UPDATED_KEY);
    const filename = `barangay_heat_risk_${cityId}_${(updated || "latest").replace(/[:.]/g, "-")}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) {
    console.error("Pipeline report download error:", err);
    return res.status(500).json({ error: "Failed to load pipeline report" });
  }
});

/**
 * POST /api/heat/:cityId/pipeline-report/generate
 * Generate the pipeline heat-risk report on demand (same logic as AI pipeline: heat + facilities + density, K-Means, PAGASA levels).
 * Frontend can call this to trigger generation, then GET pipeline-report to download. May take 1–2 min with Meteosource (per-barangay temps).
 */
router.post("/heat/:cityId/pipeline-report/generate", async (req, res) => {
  const cityId = (req.params.cityId || "").toLowerCase();
  if (cityId !== "davao") {
    return res.status(404).json({ error: "City not supported", cityId });
  }

  const meteosourceKey = process.env.METEOSOURCE_API_KEY;
  const weatherApiKey = process.env.WEATHER_API_KEY;
  if (!meteosourceKey && !weatherApiKey) {
    return res.status(503).json({
      error: "Pipeline generate requires a weather API",
      hint: "Set METEOSOURCE_API_KEY or WEATHER_API_KEY in .env",
    });
  }

  try {
    let tempsData;
    if (meteosourceKey) {
      tempsData = await fetchBarangaySpecificTemps(meteosourceKey, null);
    } else {
      tempsData = await fetchAverageTemps(weatherApiKey);
    }
    const temperatures = tempsData.temperatures || {};
    if (Object.keys(temperatures).length === 0) {
      return res.status(502).json({ error: "No temperature data returned; cannot generate report." });
    }

    const geo = await getDavaoBarangayGeo();
    const centroids = getBarangayCentroids(geo);
    const barangayIds = centroids.map((c) => c.barangayId);

    let facilities = [];
    try {
      const raw = await redis.get(FACILITIES_KEY);
      if (raw) facilities = JSON.parse(raw);
    } catch (e) {
      console.warn("Facilities not loaded for pipeline generate:", e?.message);
    }
    const facilityCounts = {};
    for (const bid of barangayIds) {
      const result = await assessFacilitiesInBarangay(bid, facilities);
      facilityCounts[bid] = result.total ?? 0;
    }

    let populationDensity = {};
    try {
      populationDensity = await getPopulationDensityByBarangayId();
    } catch (e) {
      console.warn("Population/density not loaded for pipeline generate:", e?.message);
    }

    const rows = barangayIds
      .filter((id) => typeof temperatures[id] === "number")
      .map((id) => ({
        barangay_id: id,
        temp: temperatures[id],
        facility_score: 1 / (1 + (facilityCounts[id] ?? 0)),
        density: (populationDensity[id] && Number(populationDensity[id].density)) || 0,
      }));

    if (rows.length === 0) {
      return res.status(502).json({ error: "No rows to generate; temperature data missing for all barangays." });
    }

    const csv = runPipelineReport(rows);
    const now = new Date().toISOString();
    await redis.set(PIPELINE_REPORT_KEY, csv, "EX", PIPELINE_REPORT_TTL_SEC);
    await redis.set(PIPELINE_REPORT_UPDATED_KEY, now, "EX", PIPELINE_REPORT_TTL_SEC);

    return res.status(200).json({
      ok: true,
      updatedAt: now,
      rows: rows.length,
      hint: "Download via GET /api/heat/davao/pipeline-report.",
      disclaimer: PIPELINE_REPORT_DISCLAIMER,
      sources: PIPELINE_REPORT_SOURCES,
      validity: PIPELINE_REPORT_VALIDITY,
    });
  } catch (err) {
    console.error("Pipeline report generate error:", err);
    return res.status(500).json({ error: "Failed to generate pipeline report", detail: err?.message });
  }
});

/**
 * POST /api/heat/:cityId/pipeline-report
 * Upload the latest pipeline heat-risk report CSV (e.g. from ai/run_pipeline.cmd).
 * Body: raw CSV. If PIPELINE_REPORT_WRITER_KEY is set, require header x-pipeline-report-key.
 * Report is stored in Redis and served by GET for frontend download.
 */
router.post(
  "/heat/:cityId/pipeline-report",
  express.raw({ type: ["text/csv", "text/plain"], limit: "2mb" }),
  async (req, res) => {
    const cityId = (req.params.cityId || "").toLowerCase();
    if (cityId !== "davao") {
      return res.status(404).json({ error: "City not supported", cityId });
    }
    const writerKey = process.env.PIPELINE_REPORT_WRITER_KEY;
    if (writerKey && req.get("x-pipeline-report-key") !== writerKey) {
      return res.status(401).json({ error: "Unauthorized", hint: "Set x-pipeline-report-key to PIPELINE_REPORT_WRITER_KEY." });
    }
    const body = req.body;
    const csv = Buffer.isBuffer(body) ? body.toString("utf8") : (body || "");
    if (!csv.trim()) {
      return res.status(400).json({ error: "Empty body", hint: "POST CSV with Content-Type: text/csv." });
    }
    try {
      const now = new Date().toISOString();
      await redis.set(PIPELINE_REPORT_KEY, csv, "EX", PIPELINE_REPORT_TTL_SEC);
      await redis.set(PIPELINE_REPORT_UPDATED_KEY, now, "EX", PIPELINE_REPORT_TTL_SEC);
      return res.status(201).json({
        ok: true,
        updatedAt: now,
        hint: "Users can download via GET /api/heat/davao/pipeline-report.",
      });
    } catch (err) {
      console.error("Pipeline report upload error:", err);
      return res.status(500).json({ error: "Failed to store pipeline report" });
    }
  }
);

/**
 * GET /api/heat/:cityId/barangay-temperatures
 * Returns { temperatures: { [barangayId]: temp_c }, min, max, averageTemp? }.
 * For different temps per barangay, use Meteosource (METEOSOURCE_API_KEY). WeatherAPI-only: one city average for all.
 */
router.get("/heat/:cityId/barangay-temperatures", async (req, res) => {
  const cityId = (req.params.cityId || "").toLowerCase();
  if (cityId !== "davao") {
    return res.status(404).json({ error: "City not supported", cityId });
  }

  const meteosourceKey = process.env.METEOSOURCE_API_KEY;
  const weatherApiKey = process.env.WEATHER_API_KEY;
  const useMeteosource = Boolean(meteosourceKey);

  try {
    if (useMeteosource) {
      const data = await fetchBarangaySpecificTemps(meteosourceKey, null);
      let averageTemp;
      if (weatherApiKey) {
        const avg = await fetchAverageTempOnly(weatherApiKey);
        if (typeof avg === "number") averageTemp = Math.round(avg * 10) / 10;
      }
      return res.json({
        ...data,
        ...(averageTemp != null ? { averageTemp } : {}),
        disclaimer: TEMPERATURES_DISCLAIMER,
        sources: TEMPERATURES_SOURCES,
        validity: TEMPERATURES_VALIDITY,
      });
    }
    if (weatherApiKey) {
      const data = await fetchAverageTemps(weatherApiKey);
      return res.json({
        ...data,
        disclaimer: TEMPERATURES_DISCLAIMER,
        sources: TEMPERATURES_SOURCES,
        validity: TEMPERATURES_VALIDITY,
      });
    }
    return res.status(503).json({
      error: "Weather API not configured",
      hint: "Set METEOSOURCE_API_KEY for different heat temps per barangay (recommended), or WEATHER_API_KEY for one city average for all (https://www.meteosource.com/client, https://www.weatherapi.com/my/)",
    });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({ error: err?.message || "Failed to fetch temperature data" });
  }
});

/**
 * GET /api/heat/:cityId/forecast
 * Returns 7- or 14-day forecast (historical trend) from WeatherAPI for the city center.
 * Query: ?days=7 (default) or ?days=14.
 * Requires WEATHER_API_KEY.
 */
router.get("/heat/:cityId/forecast", async (req, res) => {
  const cityId = (req.params.cityId || "").toLowerCase();
  if (cityId !== "davao") {
    return res.status(404).json({ error: "City not supported", cityId });
  }

  const weatherApiKey = process.env.WEATHER_API_KEY;
  if (!weatherApiKey) {
    return res.status(503).json({
      error: "Forecast requires WeatherAPI",
      hint: "Set WEATHER_API_KEY (https://www.weatherapi.com/my/)",
    });
  }

  const daysParam = req.query.days;
  const days = daysParam === "14" ? 14 : 7;
  const cacheKey = days === 14 ? CACHE_KEY_FORECAST_14 : CACHE_KEY_FORECAST_7;

  try {
    const now = Date.now();
    const cached = weatherCache.get(cacheKey);
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      const resp = cached.response;
      return res.json({
        ...resp,
        disclaimer: resp.disclaimer ?? FORECAST_DISCLAIMER,
        sources: resp.sources ?? FORECAST_SOURCES,
        validity: resp.validity ?? FORECAST_VALIDITY,
      });
    }

    const data = await getWeatherForecast(weatherApiKey, DAVAO_CENTER, days);
    if (!data) {
      return res.status(502).json({ error: "Failed to fetch forecast from WeatherAPI" });
    }

    const forecastDayCount = data.forecastDay?.length ?? 0;
    const response = {
      cityId,
      days,
      forecastDayCount,
      location: data.location,
      forecastDay: data.forecastDay,
      updatedAt: new Date().toISOString(),
      disclaimer: FORECAST_DISCLAIMER,
      sources: FORECAST_SOURCES,
      validity: FORECAST_VALIDITY,
    };
    weatherCache.set(cacheKey, { response, ts: now });
    return res.json(response);
  } catch (err) {
    console.error("Forecast API error:", err);
    return res.status(500).json({ error: "Failed to fetch forecast" });
  }
});

/**
 * GET /api/heat/:cityId/barangay-heat-risk
 * Returns barangay temperatures plus heuristic heat-risk assessment.
 * For different heat temps per barangay, use Meteosource (METEOSOURCE_API_KEY). WeatherAPI-only: city average for all, uniform risk.
 */
router.get("/heat/:cityId/barangay-heat-risk", async (req, res) => {
  const cityId = (req.params.cityId || "").toLowerCase();
  if (cityId !== "davao") {
    return res.status(404).json({ error: "City not supported", cityId });
  }

  // Optional cap on barangay count (Meteosource only): for initial testing; limit ignored when using WeatherAPI-only.
  const limitRaw = req.query.limit;
  const parsed = Number.parseInt(String(limitRaw ?? ""), 10);
  const limit =
    limitRaw == null || limitRaw === "" || Number.isNaN(parsed)
      ? null
      : Math.max(0, Math.min(500, parsed));

  const meteosourceKey = process.env.METEOSOURCE_API_KEY;
  const weatherApiKey = process.env.WEATHER_API_KEY;

  try {
    let tempsData;
    let temperaturesSource;
    let averageSource;

    if (meteosourceKey) {
      tempsData = await fetchBarangaySpecificTemps(meteosourceKey, limit);
      temperaturesSource = "meteosource";
      if (weatherApiKey) {
        const avg = await fetchAverageTempOnly(weatherApiKey);
        if (typeof avg === "number") tempsData.averageTemp = avg;
      }
      averageSource = weatherApiKey ? "weatherapi" : "computed";
    } else if (weatherApiKey) {
      // WeatherAPI only: city average applied to all barangays; full barangay list, uniform risk.
      tempsData = await fetchAverageTemps(weatherApiKey);
      temperaturesSource = "weatherapi";
      averageSource = "weatherapi";
    } else {
      return res.status(503).json({
        error: "Heat risk requires a weather API",
        hint: "Set METEOSOURCE_API_KEY for different heat temps per barangay (recommended), or WEATHER_API_KEY for city average for all (https://www.meteosource.com/client, https://www.weatherapi.com/my/)",
      });
    }

    let populationDensityByBarangay = {};
    try {
      populationDensityByBarangay = await getPopulationDensityByBarangayId();
    } catch (err) {
      console.warn("Population/density data not loaded, heat risk will not include urban density:", err?.message);
    }
    const assessment = assessBarangayHeatRisk(tempsData.temperatures, {
      averageTemp: tempsData.averageTemp,
      humidityByBarangay: tempsData.humidityByBarangay,
      populationDensityByBarangay,
    });

    return res.json({
      temperatures: tempsData.temperatures,
      averageTemp: assessment.averageTemp,
      risks: assessment.risks,
      minRisk: assessment.minScore,
      maxRisk: assessment.maxScore,
      counts: assessment.counts,
      legend: assessment.legend,
      basis: assessment.basis,
      usedHeatIndex: assessment.usedHeatIndex,
      updatedAt: new Date().toISOString(),
      disclaimer: HEAT_RISK_DISCLAIMER,
      sources: HEAT_RISK_SOURCES,
      validity: HEAT_RISK_VALIDITY,
      meta: {
        cityId,
        temperaturesSource,
        averageSource,
      },
    });
  } catch (err) {
    console.error("Heat risk API error:", err);
    return res.status(500).json({ error: "Failed to assess heat risk" });
  }
});

/** Barangay-specific: Meteosource per centroid, cached and throttled. limit=null means all. Max 500 when limit set (initial testing; change for official deployment if needed). */
async function fetchBarangaySpecificTemps(apiKey, limit = null) {
  try {
    const geo = await getDavaoBarangayGeo();
    const listAll = getBarangayCentroids(geo);
    const effectiveLimit =
      limit != null && Number.isFinite(limit) ? Math.max(0, Math.min(500, limit)) : null;
    const list = effectiveLimit == null ? listAll : listAll.slice(0, effectiveLimit);

    const now = Date.now();
    for (const [key, entry] of weatherCache.entries()) {
      if (key !== CACHE_KEY_AVG && now - entry.ts > CACHE_TTL_MS) weatherCache.delete(key);
    }

    const items = [];
    const keyToBarangayIds = new Map();

    for (const { barangayId, lat, lng } of list) {
      const key = cacheKey(lat, lng);
      if (!keyToBarangayIds.has(key)) {
        keyToBarangayIds.set(key, []);
        items.push({ key, lat, lng });
      }
      keyToBarangayIds.get(key).push(barangayId);
    }

    const weatherByKey = await runWithConcurrency(items, async (item) => {
      const cached = weatherCache.get(item.key);
      if (cached && now - cached.ts < CACHE_TTL_MS) {
        return { temp_c: cached.temp_c, humidity: cached.humidity };
      }
      if (METEOSOURCE_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, METEOSOURCE_DELAY_MS));
      }
      const weather = await getWeatherMeteosource(apiKey, item.lat, item.lng);
      const temp = weather && typeof weather.temp_c === "number"
        ? Math.round(weather.temp_c * 10) / 10
        : null;
      const humidity = weather && typeof weather.humidity === "number" ? weather.humidity : undefined;
      if (temp != null) weatherCache.set(item.key, { temp_c: temp, humidity, ts: now });
      return { temp_c: temp, humidity };
    });

    const temperatures = {};
    const humidityByBarangay = {};
    for (const [key, ids] of keyToBarangayIds) {
      const w = weatherByKey.get(key);
      if (w && w.temp_c != null) {
        for (const id of ids) {
          temperatures[String(id)] = w.temp_c;
          if (typeof w.humidity === "number") humidityByBarangay[String(id)] = w.humidity;
        }
      }
    }
    const values = Object.values(temperatures);
    const min = values.length ? Math.min(...values) : undefined;
    const max = values.length ? Math.max(...values) : undefined;
    return { temperatures, min, max, humidityByBarangay: Object.keys(humidityByBarangay).length ? humidityByBarangay : undefined };
  } catch (err) {
    console.error("Heat API error:", err);
    throw err;
  }
}

/** Average temp: WeatherAPI single call for Davao center, applied to all barangays. Returns averageTemp when available. */
async function fetchAverageTemps(apiKey) {
  try {
    const temp = await fetchAverageTempOnly(apiKey);

    const geo = await getDavaoBarangayGeo();
    const list = getBarangayCentroids(geo);
    const temperatures = {};
    if (temp != null) {
      for (const { barangayId } of list) {
        temperatures[barangayId] = temp;
      }
    }
    const values = Object.values(temperatures);
    const min = values.length ? Math.min(...values) : undefined;
    const max = values.length ? Math.max(...values) : undefined;
    const averageTemp = temp != null ? Math.round(temp * 10) / 10 : undefined;
    return { temperatures, min, max, averageTemp };
  } catch (err) {
    console.error("Heat API error:", err);
    throw err;
  }
}

async function fetchAverageTempOnly(apiKey) {
  const now = Date.now();
  let temp = null;
  const cached = weatherCache.get(CACHE_KEY_AVG);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    temp = cached.temp_c;
  } else {
    const weather = await getWeatherWeatherAPI(apiKey, DAVAO_CENTER);
    temp = weather && typeof weather.temp_c === "number"
      ? Math.round(weather.temp_c * 10) / 10
      : null;
    if (temp != null) weatherCache.set(CACHE_KEY_AVG, { temp_c: temp, ts: now });
  }
  return temp;
}

export default router;
