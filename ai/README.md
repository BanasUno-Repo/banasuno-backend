# AI – Weighted heat risk pipeline

This folder contains a **weighted heat risk pipeline** that uses the backend’s heat, facilities, and population APIs as input. It combines temperature, facility access, and population density (when available) with optional 7‑day rolling averages, then assigns PAGASA-style risk levels 1–5 via K‑Means and a weighted severity score.

**Relationship to the backend heat-risk API:** The backend’s `GET /api/heat/:cityId/barangay-heat-risk` uses **validated-only scoring**: NOAA Rothfusz heat index (when humidity is available) or air temperature → PAGASA level → score = (level−1)/4. Delta and density do **not** affect that score (see **docs/HEAT-RISK-MODEL-BASIS.md**). This AI pipeline uses a **different methodology** (K‑Means on temperature, facility access, and optional density) for **batch clustering and prioritization**. Use the backend API for real-time, validated per-barangay risk; use this pipeline for batch outputs that incorporate facilities and density.

## Data basis

- **Temperature** – From backend: `GET /api/heat/davao/barangay-heat-risk` (preferred) or `barangay-temperatures`. When the backend has humidity, **heat index °C** (validated, NOAA Rothfusz) is used; otherwise air temp. Optionally append daily snapshots to build history for 7‑day rolling.
- **Facility access** – From backend: `GET /api/facilities/by-barangay/:barangayId` (or batch); pipeline uses a facility score (e.g. `1 / (1 + facility_count)`) so fewer facilities → higher risk.
- **Population / density** – From backend: `GET /api/heat/davao/barangay-population` (PSA census + GeoJSON area). When present, the pipeline uses density as a third feature (higher density → higher risk weight).
- **CSV** – Pipeline expects `barangay_data.csv` with columns: `barangay_id`, `date`, `temperature`, `facility_distance` (or `facility_score`), and optional `population`, `density`. Generate rows with `fetch_pipeline_data.py` (which fetches temps, facility counts, and population/density). Optionally use **Supabase** for input/output: see **`docs/PIPELINE-SUPABASE.md`**.

## Setup

```bash
cd ai
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
```

## Test run (quick)

**Prerequisites:** Backend running (`npm start` in repo root), Redis + facilities seeded (`npm run seed:facilities`), and at least one of `WEATHER_API_KEY` or `METEOSOURCE_API_KEY` in `.env` so the heat API returns data.

**Terminal 1 – backend:**
```bash
cd path/to/banasuno-backend
npm start
```

**Terminal 2 – AI pipeline:**
```bash
cd path/to/banasuno-backend/ai
pip install -r requirements.txt
set BACKEND_URL=http://localhost:3000
python fetch_pipeline_data.py
python weighted_heat_risk_pipeline.py --input barangay_data_today.csv --no-rolling --output barangay_heat_risk_today.csv --upload
```

On Linux/macOS use `export BACKEND_URL=http://localhost:3000` instead of `set`. With `--upload`, the report is sent to the backend (Redis); users download it via the frontend (see **Report download** below).

**Windows: "Python was not found"** – Use the runner script (uses `py` launcher): from repo root run **`ai\run_pipeline.cmd`** or **`.\ai\run_pipeline.ps1`**. Or run by hand: `py -m pip install -r requirements.txt`, `py fetch_pipeline_data.py`, then `py weighted_heat_risk_pipeline.py --input barangay_data_today.csv --no-rolling --output barangay_heat_risk_today.csv`. If `py` is not found, install Python from [python.org](https://www.python.org/downloads/) and tick "Add Python to PATH".

You should see: fetch writes `barangay_data_today.csv` (one row per barangay); pipeline writes `barangay_heat_risk_today.csv` with `barangay_id`, `risk_level` (1–5), `cluster`. If the heat API returns 503 (no API key), set `WEATHER_API_KEY` or `METEOSOURCE_API_KEY` in the backend `.env`.

## Report download (no files in repo)

Reports are **not** stored in the repo. When you run the pipeline with **`--upload`** (default in `run_pipeline.cmd`):

1. The pipeline POSTs the report CSV to the backend; the backend stores it in **Redis**.
2. Users download the latest report via the **frontend**: the frontend calls **`GET /api/heat/davao/pipeline-report`** and triggers a file download (e.g. "Download heat risk report" button that opens that URL or fetches and downloads the blob).

Backend env (optional): **`PIPELINE_REPORT_WRITER_KEY`** – if set, the pipeline must send the same value in the **`x-pipeline-report-key`** header when uploading. See `.env.example`.

**Triggering generation from the frontend:** The backend can also generate the report on demand. Call **`POST /api/heat/davao/pipeline-report/generate`** (may take 1–2 min with Meteosource), then **`GET /api/heat/davao/pipeline-report`** to download. See **docs/HEAT-API.md** § 3.1.

---

## 1. Fetch data from backend APIs

Backend must be running (e.g. `npm start` in repo root). Set base URL:

```bash
# Windows PowerShell
$env:BACKEND_URL="http://localhost:3000"

# Linux/macOS
export BACKEND_URL=http://localhost:3000
```

Then run:

```bash
python fetch_pipeline_data.py
```

This writes **today’s** snapshot to `barangay_data_today.csv`. To build a 7‑day history, run this daily and append rows into `barangay_data.csv` (see script `--append` option if implemented, or concatenate manually).

## 2. Run the weighted heat risk pipeline

With a CSV that has at least one row per barangay (single day or multiple days):

```bash
python weighted_heat_risk_pipeline.py
```

- **Input:** `barangay_data.csv` (default) or path via `--input`.
- **Output:** `barangay_heat_risk_today.csv` with `barangay_id`, `risk_level` (1–5), `cluster`.

If you only have a single-day CSV (e.g. from one run of `fetch_pipeline_data.py`):

```bash
python weighted_heat_risk_pipeline.py --input barangay_data_today.csv --no-rolling --output barangay_heat_risk_today.csv
```

## Weights and clustering

- **Equal weight approach (EWA):** when **density** is present, weights **1/3** each (temperature, facility, density); when density is missing or all zero, **1/2** each (temperature, facility). EWA is a validated approach for heat vulnerability indices (see **docs/PIPELINE-COMPUTATIONAL-BASIS.md**).
- K‑Means with **k = 5**; clusters are ranked by weighted mean severity and mapped to **PAGASA levels 1–5** (1 = lowest risk, 5 = extreme danger).

**Computational basis and validation:** See **docs/PIPELINE-COMPUTATIONAL-BASIS.md** (temperature = heat index when available; EWA; MinMaxScaler; cluster → level mapping).

## Storing data in Supabase instead of CSV

To move pipeline input and the final report from CSV files in `ai/` to Supabase, see **`docs/PIPELINE-SUPABASE.md`**. It describes:

- Tables: **`pipeline_barangay_data`** (input: barangay_id, date, temperature, facility_distance) and **`pipeline_heat_risk_report`** (output: barangay_id, risk_level, cluster per report_date).
- How to change the fetch script to insert into Supabase and the pipeline to read from / write to Supabase while keeping CSV as an optional fallback.

## Files

| File | Purpose |
|------|--------|
| `weighted_heat_risk_pipeline.py` | Main pipeline: rolling averages (optional), scaling, K‑Means, weighted severity, risk level output. |
| `fetch_pipeline_data.py` | Fetches temperatures and facility counts from backend; writes CSV row(s) for today (or Supabase; see docs). |
| `requirements.txt` | Python dependencies (pandas, numpy, scikit-learn, requests). |
