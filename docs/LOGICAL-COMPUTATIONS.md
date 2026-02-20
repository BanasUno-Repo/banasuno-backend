# Logical computations in this repo

A reference to **business logic, formulas, and numeric/conditional computations** (excluding simple CRUD and I/O).

---

## 1. Heat risk model (PAGASA)

**File:** `src/services/heatRiskModel.js`  
**Model basis and references:** See **docs/HEAT-RISK-MODEL-BASIS.md** (NOAA Rothfusz, PAGASA, Estoque et al. 2020, Reid et al. 2009).

| What | Where | Formula / logic |
|------|--------|------------------|
| **Heat index (validated)** | `src/lib/heatIndex.js` | NOAA Rothfusz (NWS SR 90-23): T °C + RH % → HI °C. Used when `opts.humidityByBarangay` provided; then HI is input to PAGASA. |
| **Round to 1 decimal** | `round1(x)` | `Math.round(x * 10) / 10`. |
| **PAGASA level** | `tempToPAGASALevel(tempC)` | Input is HI °C (when humidity used) or air temp °C. Bands: &lt;27 → 1; 27–32 → 2; 33–41 → 3; 42–51 → 4; ≥52 → 5. |
| **Risk score (validated)** | `scoreFromLevel(level)` | `score = (level − 1) / 4` so level 1→0, 2→0.25, 3→0.5, 4→0.75, 5→1. No delta or density in score. |
| **City average** | `assessBarangayHeatRisk` | `computedAvg = sum(temps) / count` when `opts.averageTemp` not set; used only for `delta_c` (informational). |
| **Delta vs average** | per barangay | `delta_c = temp - avg` (reported only; not used in score). |
| **Population/density** | `src/lib/populationByBarangay.js` | Match GeoJSON `adm4_en` to PSA 2020; `density = population / area_km2`. Reported in risk object when available; not used in score. |
| **Counts by level** | `counts` | Increment `not_hazardous`, `caution`, `extreme_caution`, `danger`, `extreme_danger` from PAGASA label. |
| **Min/max score** | aggregation | `minScore` / `maxScore` over all barangay scores. |

**Constants:** `HEAT_LEVELS` (5 levels). Score uses only validated PAGASA level.

---

## 2. Geo / centroid and point-in-polygon

**File:** `src/lib/geo.js`

| What | Where | Formula / logic |
|------|--------|------------------|
| **Polygon ring** | `getPolygonRing(geometry)` | From GeoJSON: Polygon → first ring; MultiPolygon → first polygon’s first ring. |
| **Ring centroid** | `ringCentroid(ring)` | Centroid = mean of vertices: `sumLng/n`, `sumLat/n` (ring as [lng, lat][]; last point excluded as closed). |
| **Feature centroid** | `getFeatureCentroid(feature)` | Ring from geometry → `ringCentroid(ring)` → [lng, lat]. |
| **Point-in-ring** | `pointInRing(ring, lng, lat)` | Ray-casting: `inside = !inside` when ray crosses edge; edge cross: `yi > lat !== yj > lat && lng < (xj-xi)*(lat-yi)/(yj-yi) + xi`. |
| **Point-in-geometry** | `pointInGeometry(geometry, lng, lat)` | True if point inside any exterior ring of Polygon/MultiPolygon. |

---

## 3. Facilities by barangay (nearest-barangay assignment)

**File:** `src/services/facilitiesByBarangay.js`

| What | Where | Formula / logic |
|------|--------|------------------|
| **Squared distance** | `distSq(lat1, lng1, lat2, lng2)` | `(lat1-lat2)² + (lng1-lng2)²` – no sqrt (used only for comparison). |
| **Nearest barangay** | `nearestBarangayId(lat, lng, centroids)` | Minimize `distSq(lat, lng, c.lat, c.lng)` over centroids; return that barangay’s id. |
| **Assign facilities** | `assessFacilitiesInBarangay(barangayId, facilities)` | Filter facilities where `nearestBarangayId(facility.lat, facility.lng, centroids) === barangayId`. |

**Data:** Barangay centroids from `src/lib/barangays.js` (GeoJSON → centroid per feature via `getFeatureCentroid`).

---

## 4. Heat route (temperatures and aggregation)

**File:** `src/routes/heat.js`

| What | Where | Formula / logic |
|------|--------|------------------|
| **Cache TTL** | constant | `CACHE_TTL_MS = 10 * 60 * 1000` (10 min). |
| **Query limit** | `barangay-heat-risk` | `limit = clamp(parseInt(limitRaw), 0, 500)`; invalid/empty → no limit. |
| **Concurrency** | `runWithConcurrency` | Worker count = `Math.min(CONCURRENCY, items.length)` (CONCURRENCY = 5). |
| **Temp rounding** | when storing/caching | `Math.round(temp_c * 10) / 10` (1 decimal). |
| **Min/max over barangays** | `fetchAverageTemps`, `fetchBarangaySpecificTemps` | `min = Math.min(...values)`, `max = Math.max(...values)` over temp values. |
| **Average temp** | when WeatherAPI used | From single city call or from `fetchAverageTempOnly`; same value applied to all barangays in WeatherAPI-only path. |

---

## 5. Facilities list (pagination and filtering)

**File:** `src/routes/healthFacilities.js`

| What | Where | Formula / logic |
|------|--------|------------------|
| **Offset** | GET /api/facilities | `off = Math.max(0, parseInt(offset, 10) \|\| 0)`. |
| **Limit** | GET /api/facilities | `lim = Math.min(500, Math.max(1, parseInt(limit, 10) \|\| 100))`. |
| **Slicing** | response | `facilities = list.slice(off, off + lim)`. |
| **Filtering** | query params | `type` → `facility_type` includes (case-insensitive); `source`/`ownership` exact match; `name` → name includes. |

---

## 6. Weather service (forecast days)

**File:** `src/services/weatherService.js`

| What | Where | Formula / logic |
|------|--------|------------------|
| **Forecast day count** | `getForecast(apiKey, q, days)` | `dayCount = Math.min(14, Math.max(1, Number(days) \|\| 7))` – clamp to 1–14. |

---

## 7. Redis client (retry)

**File:** `src/lib/redis.js`

| What | Where | Formula / logic |
|------|--------|------------------|
| **Retry delay** | `retryStrategy(times)` | If `times > 3` stop; else delay = `Math.min(times * 200, 2000)` ms. |

---

## Summary by category

- **Risk/scoring:** PAGASA level from temp bands; normalized score; delta adjustment; min/max score and level counts (`heatRiskModel.js`).
- **Geometry:** Centroid (mean of ring vertices); point-in-polygon (ray-casting) (`geo.js`).
- **Assignment:** Squared distance; nearest-barangay; facility–barangay assignment (`facilitiesByBarangay.js`, `barangays.js`).
- **Aggregation:** Min/max/average of temps; pagination offset/limit; forecast day clamping (`heat.js`, `healthFacilities.js`, `weatherService.js`).
- **Infrastructure:** Cache TTL; concurrency cap; retry backoff (`heat.js`, `redis.js`).
