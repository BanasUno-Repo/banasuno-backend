# AI pipeline – computational basis and validation

This document describes the **computational process** of the weighted heat risk pipeline in `ai/` and what is **validated** vs standard practice.

**User-facing disclaimers (what it does, where it comes from, validity):** See **docs/DISCLAIMERS.md** § 4. The APIs **GET /api/heat/davao/pipeline-report/meta** and **POST .../pipeline-report/generate** return `disclaimer`, `sources`, and `validity` for in-app display.

---

## Full explanation of the pipeline’s computational logic

### What the pipeline does (in order)

1. **Load data**  
   Reads a CSV with one row per barangay per date. Required columns: `barangay_id`, `date`, `temperature`, `facility_distance` (or `facility_score`). Optional: `population`, `density`. The fetch script (`fetch_pipeline_data.py`) fills this CSV from backend APIs.

2. **Temperature feature**  
   - If there are multiple dates: for each barangay, **7‑day rolling mean** of `temperature` → `temp_rolling`.  
   - If only one date: `temp_rolling` = `temperature`.  
   The value in `temperature` is **heat index °C** when the backend had humidity and returned `heat_index_c`; otherwise it is **air temp °C**.

3. **Other features**  
   - **facility_score** = same as `facility_distance` in the CSV, which is **1 / (1 + facility_count)** (fewer facilities → higher value).  
   - **density** = persons/km² from backend (PSA 2020 + GeoJSON area). If missing, set to 0.

4. **Feature set and weights**  
   - If any row has density > 0: use **three features** — `temp_rolling`, `facility_score`, `density` — with **equal weights 1/3** each.  
   - If all density is 0: use **two features** — `temp_rolling`, `facility_score` — with **equal weights 1/2** each.

5. **Scale features**  
   **MinMaxScaler** (scikit-learn): each feature is rescaled to [0, 1] using the min and max of that feature over the dataset. So every feature is on the same scale before combining.

6. **Cluster**  
   **K‑Means** with **k = 5** and a fixed random seed (42). Each row gets a **cluster** label 0–4. So barangays are grouped into 5 clusters in feature space.

7. **Severity per cluster**  
   For each cluster, compute the **mean** of each (scaled) feature over the rows in that cluster. Then:  
   **severity_score** = (mean of feature 1)×(weight 1) + (mean of feature 2)×(weight 2) + …  
   using the same EWA weights (1/3 each or 1/2 each).

8. **Map clusters to PAGASA levels 1–5**  
   Rank the 5 clusters by **severity_score** (ascending: lowest score = rank 1, highest = rank 5). Then:  
   - cluster with **lowest** severity → **risk_level 1** (lowest risk),  
   - … up to …  
   - cluster with **highest** severity → **risk_level 5** (extreme danger).  
   So every barangay gets a **risk_level** in {1, 2, 3, 4, 5} that matches PAGASA’s five categories.

9. **Output**  
   For the **latest date** in the CSV, write one row per barangay: `barangay_id`, `risk_level`, `cluster`.

---

### Where each part comes from and how it’s valid

| Step / quantity | Where it’s from | How it’s valid |
|------------------|-----------------|-----------------|
| **Temperature (or heat index)** | Backend `barangay-heat-risk` (or `barangay-temperatures`). When backend had humidity, fetch uses **heat_index_c**. | **Valid when heat index:** computed with **NOAA Rothfusz** (NWS SR 90-23), official formula. **Source:** https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml . When only air temp is used, the value is not the full PAGASA “heat index” (which includes humidity) but the same °C scale and bands still apply. |
| **PAGASA levels 1–5** | We assign **five** ordinal levels and call them PAGASA levels. | **Valid:** Level names and **temperature bands** (27–32 Caution, 33–41 Extreme Caution, etc.) come from **PAGASA**. **Source:** https://www.pagasa.dost.gov.ph/weather/heat-index . We do not recompute level from temperature in the pipeline; we use k=5 clusters and **map** cluster rank → level 1–5 so the **output** is consistent with PAGASA’s five categories. |
| **Facility score 1/(1+n)** | We define it: n = facility count from backend; score = 1/(1+n). | **Not from a single cited formula.** It is a **standard inverse proxy**: “less access (fewer facilities) → higher value” is a common idea in access/vulnerability indices. No paper in our cited list says “use exactly 1/(1+n)” for heat risk; we use it as a simple, reproducible proxy. |
| **Density** | Backend `barangay-population`: PSA 2020 census + GeoJSON area → persons/km². | **Data source is official (PSA).** Using density as an **exposure** or vulnerability factor is supported **conceptually** by literature (e.g. Estoque et al. 2020, Reid et al. 2009 — hazard + exposure + vulnerability). We do not cite a specific formula that says “use density with weight 1/3”; the **weight** comes from EWA (see next row). |
| **Equal weights (1/3 or 1/2)** | We assign the same weight to each feature (temperature, facility, density when present; else temp and facility only). | **Validated:** The **equal weight approach (EWA)** for heat vulnerability–style indices has been validated in the literature. Toronto study (Urban Climate 2024) shows EWA gives similar results to PCA and is simpler and reproducible. **DOI:** 10.1016/j.uclim.2024.101838 . Niu et al. systematic review (Current Climate Change Reports 2021) gives context on HVI methods. **DOI:** 10.1007/s40641-021-00173-3 . So the **method** of weighting (equal per feature) is validated; the **choice of features** (temp, facility, density) is ours, with facility and density as above. |
| **MinMaxScaler** | scikit-learn: scale each feature to [0,1] by (x - min) / (max - min). | **Standard:** Common in composite indices and ML. Reproducible and well-defined. No separate citation; it is standard practice. |
| **K‑Means k=5** | We choose k=5 to match PAGASA’s five levels. | **Reproducible:** Fixed seed (42) so runs are deterministic. k=5 is chosen to align output with PAGASA 1–5, not from a single paper that says “use k=5 for heat risk.” So the **number** of clusters is a design choice; the **algorithm** (K‑Means) is standard. |
| **Cluster → level by severity rank** | We define it: rank clusters by weighted mean severity; rank 1 → level 1, …, rank 5 → level 5. | **Reproducible and consistent:** Clear rule so that “worst” cluster (highest severity) becomes level 5 and “best” (lowest severity) becomes level 1. This makes the pipeline output **ordinal** and **aligned with PAGASA’s five categories** in name and meaning. |
| **7‑day rolling mean of temperature** | We use it when multiple dates exist. | **Standard smoothing;** no specific citation. Common way to smooth daily values. |

---

### Short validity summary

- **Validated (with a cited or official source):**  
  - **Temperature when heat index:** NOAA Rothfusz (NWS SR 90-23).  
  - **PAGASA categories (levels 1–5 and bands):** PAGASA.  
  - **Equal weight approach (EWA):** Toronto 2024 (DOI 10.1016/j.uclim.2024.101838), Niu et al. 2021 (DOI 10.1007/s40641-021-00173-3).

- **Standard / reproducible, not from a single validation study:**  
  MinMaxScaler, K‑Means, ranking clusters by severity to get levels 1–5, 7‑day rolling mean.

- **Conceptual support only (no formula validation):**  
  Using **density** as an exposure factor (Estoque, Reid).  
  Using **facility score** as access proxy; the **formula** 1/(1+n) is a standard inverse proxy, not taken from a cited paper.

All cited sources, with links and DOIs, are in **docs/CITED-SOURCES.md**.

---

## 1. Data inputs

| Input | Source | Validated? |
|-------|--------|------------|
| **Temperature** | Backend `GET /api/heat/davao/barangay-heat-risk` or `barangay-temperatures`. When the backend had humidity (Meteosource), the fetch script uses **heat_index_c** (NOAA Rothfusz, NWS SR 90-23). Otherwise air temp °C. | **Yes** when heat index is used (see **docs/HEAT-RISK-MODEL-BASIS.md**). Air temp only is not fully aligned with PAGASA heat index definition. |
| **Facility score** | Backend facilities API → `1 / (1 + facility_count)` per barangay. Fewer facilities → higher value (access/risk proxy). | **Standard proxy**; no single validated formula. Inverse relationship is common in access indices. |
| **Population / density** | Backend `GET /api/heat/davao/barangay-population` (PSA 2020 census + GeoJSON area). persons/km². | **Data source** is official (PSA); use of density as exposure proxy is supported conceptually (e.g. Estoque et al., Reid et al.). |

---

## 2. Feature scaling and weights

- **Scaling:** **MinMaxScaler** (sklearn) – each feature scaled to [0, 1] across the dataset. Standard and reproducible.
- **Weights:** **Equal weight approach (EWA)** – each feature gets the same weight: **1/3** when three features (temperature, facility_score, density), **1/2** when two (temperature, facility_score).  
  **Validation:** EWA has been validated for heat vulnerability indices; studies (e.g. Toronto spatial heat vulnerability) show it produces similar results to PCA and is simpler and reproducible. See e.g. systematic reviews on heat vulnerability index development (PMC8531084, MDPI 1660-4601).

---

## 3. Clustering and risk levels

- **Algorithm:** **K-Means** with **k = 5** (fixed seed for reproducibility).
- **Mapping to PAGASA levels 1–5:** Cluster centroids are computed; each cluster is assigned a **severity score** = weighted mean of the scaled features (using the same EWA weights). Clusters are **ranked** by this severity (ascending); rank 1 → PAGASA level 1 (lowest risk), rank 5 → level 5 (extreme danger).  
  This gives a **deterministic, reproducible** mapping from clusters to ordinal risk levels consistent with PAGASA’s five categories.

---

## 4. Rolling average (optional)

- When multiple days of data exist, **7-day rolling mean** of temperature (per barangay) is used as the temperature feature. Single-day data uses raw temperature.  
  Standard practice for smoothing; no separate validation cited.

---

## 5. Summary: what is validated

| Step | Validated? | Notes |
|------|------------|--------|
| Temperature = heat index when available | **Yes** | NOAA Rothfusz (NWS SR 90-23) when backend provides it. |
| Equal weights (EWA) | **Yes** | Validated in heat vulnerability index literature. |
| MinMaxScaler | Standard | Common, reproducible. |
| K-Means k=5 → rank by severity → levels 1–5 | **Reproducible** | Clear rule; k=5 matches PAGASA levels. |
| Facility score 1/(1+n) | **Standard proxy** | Not from a single validated formula. |
| Density as feature | **Conceptual** | Exposure proxy (literature support); weight from EWA. |

For the **backend** heat-risk API (real-time, per-barangay score), see **docs/HEAT-RISK-MODEL-BASIS.md**.

**Full list of cited sources (with links and DOIs):** **docs/CITED-SOURCES.md**.
