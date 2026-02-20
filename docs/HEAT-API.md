# Heat API – Barangay temperature & heuristic model

This document describes the **backend** API and logic for barangay-level temperature / heat data. The backend is the source of truth; the frontend only consumes the API and renders the heat map.

---

## 1. API contract

**Endpoint**

```http
GET /api/heat/:cityId/barangay-temperatures
```

**Query (optional, for future use)**  
`?date=YYYY-MM-DD` or `?timestamp=...` for point-in-time.

**Response**

```json
{
  "temperatures": {
    "1130700001": 31.2,
    "1130700002": 33.1
  },
  "min": 26,
  "max": 39,
  "averageTemp": 30.5,
  "updatedAt": "2025-02-15T12:00:00Z"
}
```

- **`temperatures`** – Map of barangay identifier (PSGC `adm4_psgc` or feature `id`) → temperature (°C). Keys must match the GeoJSON used by the frontend.
- **`min`** / **`max`** – Range for the legend and for normalizing to 0–1 intensity on the frontend.
- **`averageTemp`** – (Optional) City-level average temperature (°C) from WeatherAPI when `WEATHER_API_KEY` is set. Omitted when not available.
- **`updatedAt`** – (Optional) When the data was produced.

---

## 2. Backend responsibilities

The backend **owns**:

- **Sources of truth** for temperature: sensors, third-party APIs (e.g. WeatherAPI), cached or historical data.
- **Business rules**: aggregation, time window, min/max range, validation.
- **Resolving** `cityId` (e.g. `davao`) to the correct geographic / barangay set and returning temperatures keyed by barangay ID.

The frontend calls this API and uses the response in `getBarangayHeatData` → `buildHeatPointsFromBarangays`; it does not implement temperature logic.

---

## 3. Current implementation

- **Route:** `src/routes/heat.js`
- **Different heat temp per barangay:** Use **METEOSOURCE_API_KEY**. [Meteosource](https://www.meteosource.com/documentation) point API fetches temperature per barangay (each feature’s centroid). `src/services/meteosourceService.js` + `src/lib/geo.js`. Cached by location (10 min). To avoid rate limits: default 5 concurrent requests; set **METEOSOURCE_CONCURRENCY** (e.g. 2–3) to lower, or **METEOSOURCE_DELAY_MS** (e.g. 200) to add a delay before each uncached request. See `.env.example`.
- **Fallback (one temp for all):** When only `WEATHER_API_KEY` is set, [WeatherAPI](https://www.weatherapi.com/docs/) returns a single average (Davao City center) applied to all barangays. One call, cached 10 minutes.
- Env: `METEOSOURCE_API_KEY` for per-barangay different temps; `WEATHER_API_KEY` for city average (optional with Meteosource, or sole source for uniform temp). See `.env.example`.

### 3.1 Pipeline report (generate and download)

The pipeline heat-risk report is stored in Redis (not in the repo). Users can **generate** it from the frontend, then **download** it.

- **POST /api/heat/davao/pipeline-report/generate** – Generates the report on demand (same logic as the AI pipeline: heat + facilities + density, K-Means, PAGASA levels 1–5). May take 1–2 minutes with Meteosource (per-barangay temps). Returns `{ ok, updatedAt, rows }`. No auth required; call from the frontend to trigger generation.
- **GET /api/heat/davao/pipeline-report** – Returns the latest report as a CSV file (`Content-Disposition: attachment`). Responds 404 if no report has been generated or uploaded.
- **POST /api/heat/davao/pipeline-report** – Upload report (body: `text/csv`). Used by the Python pipeline when run with `--upload`. If `PIPELINE_REPORT_WRITER_KEY` is set, the request must include header `x-pipeline-report-key`.

**Frontend flow to trigger generate then download:**

1. **“Generate report”** – `POST /api/heat/davao/pipeline-report/generate`. Show a loading state (request can take 1–2 min). On success (200), show “Report ready” and enable the download button. The response includes `disclaimer`, `sources`, and `validity` for display.
2. **“Download report”** – Open or fetch `GET /api/heat/davao/pipeline-report` and trigger a file download. If 404, show “No report available; generate one first.”
3. **Disclaimers** – Use **`GET /api/heat/davao/pipeline-report/meta`** for `disclaimer`, `sources`, and `validity` to show next to the download button. Same fields are in **`GET /api/heat/davao/barangay-heat-risk`** for the map (display near the heat map legend).

**In-app disclaimers:** All relevant APIs return short **disclaimer**, **sources**, and **validity** text. Full text: **docs/DISCLAIMERS.md**.
</think>

<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>
TodoWrite

---

## 4. Heuristic AI model (target)

The aim is to treat this as a **heuristic AI model** so that:

1. **Rules and heuristics** – Explicit rules (e.g. time-of-day, land use, elevation, distance from water) can adjust or weight raw observations.
2. **Pluggable inputs** – Temperature can come from WeatherAPI, sensor feeds, or other APIs; the model layer combines them with heuristics.
3. **Per-barangay variation** – Move from one city-level value to per-barangay estimates using geography, proxies, or a small model.
4. **Future ML** – The same API contract can be backed by a trained model (e.g. predicting heat index or risk) while the frontend stays unchanged.

**Suggested next steps**

- Introduce a **heat model** module (e.g. `src/services/heatRiskModel.js`, which already exists) that:
  - Takes raw inputs (weather API, optional sensors).
  - Applies heuristic rules (e.g. feels-like, time window, barangay-level adjustments).
  - Returns `{ temperatures, min, max }` for the existing route.
- Keep the route thin: it calls the model and returns the JSON above.
- Later, replace or augment the heuristic layer with a trained model that consumes the same inputs and still returns the same response shape.
