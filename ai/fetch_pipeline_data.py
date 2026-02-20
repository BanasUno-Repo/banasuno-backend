#!/usr/bin/env python3
"""
Fetch data from backend APIs for the weighted heat risk pipeline.

- GET /api/heat/davao/barangay-temperatures → temperatures per barangay
- GET /api/heat/davao/barangay-heat-risk → when available, heat_index_c (validated NOAA Rothfusz) is used as temperature for the pipeline
- GET /api/facilities/by-barangay/:id (or batch) → facility count per barangay
- GET /api/heat/davao/barangay-population → population, density

Writes CSV with columns: barangay_id, date, temperature, facility_distance, population, density.
temperature: heat index °C when backend returns it (validated); else air temp °C.
facility_distance = 1/(1+facility_count). population/density from barangay-population.

Requires: BACKEND_URL (e.g. http://localhost:3000)
"""

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests


def get_barangay_temperatures(base_url: str, timeout: int = 120) -> dict[str, float]:
    """Fetch barangay temperatures from heat API. May take 1–2 min when backend calls Meteosource per barangay."""
    url = f"{base_url.rstrip('/')}/api/heat/davao/barangay-temperatures"
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    temps = data.get("temperatures") or {}
    return {str(k): float(v) for k, v in temps.items() if v is not None}


def get_barangay_heat_risk(base_url: str, timeout: int = 120) -> tuple[dict[str, float], bool, str]:
    """
    Fetch barangay heat-risk from backend. When backend used humidity, risks include heat_index_c (validated).
    Returns (barangay_id -> value to use as temperature, used_heat_index, temperatures_source).
    value = heat_index_c when present, else temp_c.
    temperatures_source = "meteosource" (per-barangay) or "weatherapi" (city average for all) or "".
    """
    url = f"{base_url.rstrip('/')}/api/heat/davao/barangay-heat-risk"
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    risks = data.get("risks") or {}
    out: dict[str, float] = {}
    used_hi = False
    for bid, risk in risks.items():
        if not isinstance(risk, dict):
            continue
        # Prefer validated heat index when backend computed it
        hi = risk.get("heat_index_c")
        temp = risk.get("temp_c")
        if isinstance(hi, (int, float)):
            out[str(bid)] = float(hi)
            used_hi = True
        elif isinstance(temp, (int, float)):
            out[str(bid)] = float(temp)
    temperatures_source = (data.get("meta") or {}).get("temperaturesSource") or ""
    return out, used_hi, temperatures_source


def get_facility_count(base_url: str, barangay_id: str) -> int:
    """Fetch facility count for one barangay."""
    url = f"{base_url.rstrip('/')}/api/facilities/by-barangay/{barangay_id}"
    r = requests.get(url, timeout=15)
    if r.status_code == 404:
        return 0
    r.raise_for_status()
    data = r.json()
    return int(data.get("total") or 0)


def get_facility_counts_batch(base_url: str, barangay_ids: list[str], timeout: int = 60) -> dict[str, int]:
    """Fetch facility counts for many barangays in one request (faster). Returns { barangay_id: count }."""
    url = f"{base_url.rstrip('/')}/api/facilities/counts-by-barangays"
    r = requests.post(url, json={"barangayIds": list(barangay_ids)}, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    counts = data.get("counts") or {}
    return {str(k): int(v) for k, v in counts.items()}


def facility_count_to_distance(facility_count: int) -> float:
    """Convert facility count to a risk proxy: fewer facilities = higher value (like distance)."""
    return 1.0 / (1.0 + facility_count)


def get_barangay_population_density(base_url: str, timeout: int = 30) -> dict[str, dict]:
    """Fetch population and density per barangay. Returns { barangay_id: { population, density } }."""
    url = f"{base_url.rstrip('/')}/api/heat/davao/barangay-population"
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, dict):
        return {}
    out: dict[str, dict] = {}
    for k, v in data.items():
        if not isinstance(v, dict):
            out[str(k)] = {"population": 0, "density": 0.0}
            continue
        try:
            pop = int(v.get("population", 0) or 0)
            dens = float(v.get("density", 0) or 0)
        except (TypeError, ValueError):
            pop, dens = 0, 0.0
        out[str(k)] = {"population": pop, "density": dens}
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch heat + facilities data from backend for AI pipeline")
    parser.add_argument(
        "--output",
        default="barangay_data_today.csv",
        help="Output CSV path (today's snapshot)",
    )
    parser.add_argument(
        "--append",
        metavar="CSV",
        help="Append today's rows to this CSV (e.g. barangay_data.csv) for rolling history",
    )
    parser.add_argument(
        "--backend",
        default=os.environ.get("BACKEND_URL", "http://localhost:3000"),
        help="Backend base URL (default: BACKEND_URL or http://localhost:3000)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120,
        help="Timeout in seconds for heat API (default 120; increase if Meteosource is slow)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=20,
        help="Concurrent requests for facility counts (default 20)",
    )
    args = parser.parse_args()

    base_url = args.backend.rstrip("/")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Fetch heat and population in parallel (heat is the long pole; population is fast).
    print(f"Requesting heat and population from {base_url} (timeout={args.timeout}s) ...", flush=True)
    temperatures: dict[str, float] = {}
    used_heat_index = False
    population_density: dict[str, dict] = {}

    def fetch_heat() -> tuple[dict[str, float], bool, str]:
        try:
            return get_barangay_heat_risk(base_url, timeout=args.timeout)
        except requests.RequestException:
            return ({}, False, "")

    def fetch_population() -> dict[str, dict]:
        try:
            return get_barangay_population_density(base_url, timeout=min(60, args.timeout))
        except (requests.RequestException, AttributeError, TypeError, ValueError):
            return {}

    with ThreadPoolExecutor(max_workers=2) as executor:
        fut_heat = executor.submit(fetch_heat)
        fut_pop = executor.submit(fetch_population)
        temperatures, used_heat_index, temperatures_source = fut_heat.result()
        population_density = fut_pop.result()

    if not temperatures:
        try:
            temperatures = get_barangay_temperatures(base_url, timeout=args.timeout)
            print("  Using temperatures from barangay-temperatures (source unknown).", flush=True)
        except requests.RequestException as e:
            print(f"Error fetching temperatures: {e}", file=sys.stderr)
            return 1
    else:
        if temperatures_source == "meteosource":
            print("  Per-barangay temperatures (Meteosource live).", flush=True)
        elif temperatures_source == "weatherapi":
            print("  City average applied to all barangays (WeatherAPI fallback).", flush=True)
        else:
            print("  Using temperatures from barangay-heat-risk.", flush=True)
        if used_heat_index:
            print("  Heat index (validated) used as temperature.", flush=True)
    if not population_density:
        print("  Population/density not available, using 0 for pipeline.", flush=True)

    if not temperatures:
        print("No barangay temperatures returned from API.", file=sys.stderr)
        return 1

    n = len(temperatures)
    barangay_ids = list(temperatures.keys())

    # Prefer batch endpoint (1 request); fall back to parallel per-barangay requests
    facility_counts: dict[str, int] = {}
    try:
        print(f"Fetched temperatures for {n} barangays. Fetching facility counts (batch)...", flush=True)
        facility_counts = get_facility_counts_batch(base_url, barangay_ids)
        if len(facility_counts) < n:
            for bid in barangay_ids:
                if bid not in facility_counts:
                    facility_counts[bid] = 0
    except requests.RequestException as e:
        print(f"  Batch not available ({e}), using {args.workers} parallel requests...", flush=True)
        def fetch_one(bid: str) -> tuple[str, int]:
            try:
                return (bid, get_facility_count(base_url, bid))
            except requests.RequestException:
                return (bid, 0)

        done = 0
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {executor.submit(fetch_one, bid): bid for bid in barangay_ids}
            for future in as_completed(futures):
                barangay_id, count = future.result()
                facility_counts[barangay_id] = count
                done += 1
                if done % 50 == 0 or done == n:
                    print(f"  {done}/{n} facility counts...", flush=True)

    rows = [
        {
            "barangay_id": barangay_id,
            "date": today,
            "temperature": round(temp, 2),
            "facility_distance": round(facility_count_to_distance(facility_counts.get(barangay_id, 0)), 6),
            "population": population_density.get(barangay_id, {}).get("population", 0),
            "density": round(population_density.get(barangay_id, {}).get("density", 0), 4),
        }
        for barangay_id, temp in temperatures.items()
    ]

    df = pd.DataFrame(rows)

    if args.append:
        append_path = Path(args.append)
        if append_path.exists():
            existing = pd.read_csv(append_path)
            for c in df.columns:
                if c not in existing.columns:
                    existing[c] = pd.NA
            df = pd.concat([existing, df], ignore_index=True)
        df.to_csv(append_path, index=False)
        print(f"Appended {len(rows)} rows to {append_path}", flush=True)
    else:
        df.to_csv(args.output, index=False)
        print(f"Wrote {len(rows)} rows to {args.output}", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
