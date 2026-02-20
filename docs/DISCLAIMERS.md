# Disclaimers – What each process does, where it comes from, and validity

This document describes **what each process actually does**, **where the data comes from**, and the **validity and limitations** of outputs. Use these for in-app disclaimers and to cite sources.

---

## 1. Barangay temperatures (heat map data)

**What it does:** Provides **air temperature (°C)** per barangay (or one city-wide value for all barangays) for the heat map. Used as the primary input for the heat-risk assessment.

**Where it comes from:**
- **Meteosource** (when `METEOSOURCE_API_KEY` is set): Per-point current weather by barangay centroid (lat/lon). Each barangay can have a different temperature. Cached 10 minutes per location.
- **WeatherAPI** (when only `WEATHER_API_KEY` is set): Single current weather call for Davao City center; that value is applied to **all** barangays. Cached 10 minutes.

**Validity and limitations:**
- Temperatures are **model/API outputs**, not official PAGASA or NWS observations. They are suitable for **planning and awareness**, not for regulatory or official hazard declaration.
- When **humidity** is available (e.g. from Meteosource), the backend can compute **heat index** (NOAA Rothfusz) and use it for risk levels; see **Barangay heat risk** below.
- **Not a substitute** for local weather stations or official heat advisories from PAGASA.

**References:** See **docs/HEAT-RISK-MODEL-BASIS.md** and **docs/CITED-SOURCES.md**.

---

## 2. Barangay heat risk (map risk levels)

**What it does:** Assigns each barangay a **risk level 1–5** (PAGASA-style: Not Hazardous, Caution, Extreme Caution, Danger, Extreme Danger) and a **score 0–1**. The score is derived **only** from the validated PAGASA level; population/density and delta from average are **reported for information** and do **not** change the score.

**Where it comes from:**
- **Input:** Barangay temperatures (from Meteosource or WeatherAPI, see above). Optionally **relative humidity** per barangay (e.g. Meteosource) for heat index.
- **Heat index (when humidity available):** **NOAA Rothfusz** formula (NWS SR 90-23). Official source: https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
- **Risk levels and bands:** **PAGASA** heat index classification (27–32°C Caution, 33–41°C Extreme Caution, etc.). Official source: https://www.pagasa.dost.gov.ph/weather/heat-index
- **Score:** `(level − 1) / 4` so level 1→0, 5→1. No delta or density in score.

**Validity and limitations:**
- When **heat index** is used (`usedHeatIndex: true` in the API), the **level and score** are based on **validated** methods (NOAA + PAGASA).
- When only **air temperature** is used (no humidity), the same PAGASA **bands** are applied to temperature; this is **not** the full PAGASA “heat index” (which includes humidity) but preserves the same category scale.
- Outputs are **for planning and awareness only**. They are **not** official PAGASA heat advisories or regulatory determinations.

**References:** **docs/HEAT-RISK-MODEL-BASIS.md**, **docs/LOGICAL-COMPUTATIONS.md**, **docs/CITED-SOURCES.md**.

---

## 3. Forecast (7- or 14-day)

**What it does:** Returns **7- or 14-day weather forecast** for Davao City (single location). Used for trend and planning, not per-barangay risk.

**Where it comes from:** **WeatherAPI** (https://www.weatherapi.com). One request per city center; cached 10 minutes.

**Validity and limitations:**
- Forecast data is from a **third-party provider**. It is **not** from PAGASA or NWS. Use for **general planning** only; do not rely for official warnings or critical decisions.

---

## 4. Pipeline heat-risk report (generate and download)

**What it does:** Produces a **CSV report** of barangay-level **risk_level** (1–5) and **cluster** from a **weighted pipeline**: temperature (or heat index when available), **facility access** (fewer facilities → higher risk proxy), and **population density** (when available). Uses **K-Means** (k=5) and **equal-weight** combination, then maps clusters to PAGASA-style levels 1–5 by severity rank. This is a **different methodology** from the map’s heat risk: the map uses **validated-only** (heat index or temp → PAGASA → score); the pipeline adds **facilities and density** for **batch prioritization**.

**Where it comes from:**
- **Temperature / heat index:** Same as barangay heat risk (Meteosource or WeatherAPI; heat index when humidity available).
- **Facility score:** Backend facilities data (Redis); score = **1 / (1 + facility_count)** per barangay.
- **Population / density:** **PSA 2020** census + GeoJSON area → persons/km² (backend `barangay-population`).
- **Method:** Equal weight approach (EWA), MinMaxScaler, K-Means k=5, cluster rank → level 1–5. See **docs/PIPELINE-COMPUTATIONAL-BASIS.md**.

**Validity and limitations:**
- **Validated (cited):** Temperature when heat index (NOAA Rothfusz); PAGASA level bands; EWA weighting (literature-supported).
- **Standard / reproducible:** MinMaxScaler, K-Means, cluster→level mapping. **Facility score** 1/(1+n) is a common access proxy, not from a single cited formula. **Density** as exposure factor is conceptually supported (e.g. Estoque et al., Reid et al.); exact weight is our choice.
- Reports are **for planning and prioritization only**. They are **not** official health or hazard reports and should **not** be used as the sole basis for resource allocation or regulatory decisions. Always combine with official sources and local knowledge.

**References:** **docs/PIPELINE-COMPUTATIONAL-BASIS.md**, **docs/CITED-SOURCES.md**, **ai/README.md**.

---

## Summary table

| Process              | What it does                          | Main data sources              | Validity / use                          |
|----------------------|----------------------------------------|--------------------------------|-----------------------------------------|
| Barangay temperatures| Temp °C per barangay (or city-wide)   | Meteosource, WeatherAPI        | For planning; not official observations |
| Barangay heat risk   | Level 1–5 + score from temp/heat index| NOAA Rothfusz, PAGASA          | Validated when heat index; for awareness only |
| Forecast             | 7/14-day forecast for city            | WeatherAPI                     | Third-party; for general planning       |
| Pipeline report      | CSV risk_level by barangay (temp + facilities + density) | Same temps, Redis facilities, PSA + GeoJSON | EWA + K-Means; for prioritization only; not official |

---

**Full citations and DOIs:** **docs/CITED-SOURCES.md**.

---

## API response fields (for frontend)

- **GET /api/heat/davao/barangay-temperatures** – Response includes `disclaimer`, `sources`, `validity`. Display when showing temperature data or heat map data source.
- **GET /api/heat/davao/barangay-heat-risk** – Response includes `disclaimer`, `sources`, `validity` (and `basis`, `usedHeatIndex`). Display near the heat map legend.
- **GET /api/heat/davao/forecast** – Response includes `disclaimer`, `sources`, `validity`. Display when showing the 7/14-day forecast.
- **GET /api/heat/davao/pipeline-report/meta** – Returns `available`, `updatedAt`, `disclaimer`, `sources`, `validity`, `docs`. Use when showing the pipeline report download section.
- **POST /api/heat/davao/pipeline-report/generate** – Response includes `disclaimer`, `sources`, `validity` so the frontend can show them after generation.
