#!/usr/bin/env python3
"""
Weighted heat risk pipeline.

Uses barangay_data.csv (barangay_id, date, temperature, facility_distance, optional population/density)
from API-backed data. Computes 7-day rolling averages, normalizes features,
runs K-Means (k=5), then assigns PAGASA risk levels 1–5 by weighted severity.

Weights: equal weights (EWA) – 1/3 each when 3 features (temp, facility, density), 1/2 each when 2 features.
Temperature: use heat index °C when fetch script got it from backend (validated); else air temp.
Computational basis: docs/PIPELINE-COMPUTATIONAL-BASIS.md.
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.preprocessing import MinMaxScaler


def load_data(path: str) -> pd.DataFrame:
    """Load CSV with required columns: barangay_id, date, temperature, facility_distance (or facility_score). Optional: population, density."""
    df = pd.read_csv(path)
    for col in ["barangay_id", "date", "temperature", "facility_distance"]:
        if col not in df.columns and col != "facility_distance":
            raise ValueError(f"Missing required column: {col}")
    if "facility_distance" not in df.columns and "facility_score" in df.columns:
        df["facility_distance"] = df["facility_score"]
    elif "facility_distance" not in df.columns:
        raise ValueError("Missing column: facility_distance or facility_score")
    if "density" not in df.columns:
        df["density"] = 0.0
    if "population" not in df.columns:
        df["population"] = 0
    return df


def prepare_features(
    df: pd.DataFrame,
    use_rolling: bool = True,
    window: int = 7,
) -> tuple[pd.DataFrame, np.ndarray, list[str], np.ndarray]:
    """
    Compute rolling (or raw) features and scaled feature matrix.
    Returns (df with new columns, features_scaled, feature_names, weights).
    """
    df = df.sort_values(["barangay_id", "date"]).copy()

    if use_rolling and df["date"].nunique() > 1:
        df["temp_rolling"] = df.groupby("barangay_id")["temperature"].transform(
            lambda x: x.rolling(window=window, min_periods=1).mean()
        )
    else:
        df["temp_rolling"] = df["temperature"]

    df["facility_score"] = df["facility_distance"]
    df["density"] = pd.to_numeric(df["density"], errors="coerce").fillna(0)

    has_density = df["density"].gt(0).any()
    if has_density:
        feature_cols = ["temp_rolling", "facility_score", "density"]
        weights = np.array([1.0 / 3, 1.0 / 3, 1.0 / 3])  # Equal weight approach (EWA), validated
    else:
        feature_cols = ["temp_rolling", "facility_score"]
        weights = np.array([0.5, 0.5])  # Equal weight approach (EWA), validated

    features = df[feature_cols].copy()
    features = features.fillna(features.mean(numeric_only=True))
    scaler = MinMaxScaler()
    features_scaled = scaler.fit_transform(features)

    return df, features_scaled, feature_cols, weights


def run_kmeans_and_risk_levels(
    df: pd.DataFrame,
    features_scaled: np.ndarray,
    feature_cols: list[str],
    weights: np.ndarray,
    n_clusters: int = 5,
    random_state: int = 42,
) -> pd.DataFrame:
    """Assign clusters and map to PAGASA risk levels 1–5 by weighted severity."""
    kmeans = KMeans(n_clusters=n_clusters, random_state=random_state)
    df = df.copy()
    df["cluster"] = kmeans.fit_predict(features_scaled)

    cluster_means = df.groupby("cluster")[feature_cols].mean()
    cluster_means["severity_score"] = cluster_means.dot(weights)
    cluster_rank = cluster_means["severity_score"].rank(method="first", ascending=True).astype(int).to_dict()
    df["risk_level"] = df["cluster"].map(lambda x: int(cluster_rank[x]))

    return df


def main() -> int:
    parser = argparse.ArgumentParser(description="Weighted heat risk pipeline (K-Means + PAGASA levels)")
    parser.add_argument(
        "--input",
        default="barangay_data.csv",
        help="Input CSV (barangay_id, date, temperature, facility_distance, optional population/density)",
    )
    parser.add_argument(
        "--output",
        default="barangay_heat_risk_today.csv",
        help="Output CSV with barangay_id, risk_level, cluster",
    )
    parser.add_argument(
        "--no-rolling",
        action="store_true",
        help="Use raw values instead of 7-day rolling (e.g. single-day data)",
    )
    parser.add_argument("--window", type=int, default=7, help="Rolling window size (default 7)")
    parser.add_argument("--clusters", type=int, default=5, help="K-Means clusters (default 5)")
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Upload report CSV to backend (BACKEND_URL) for frontend download; optional PIPELINE_REPORT_WRITER_KEY",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: input file not found: {input_path}", file=sys.stderr)
        return 1

    print(f"Loading {input_path} and running pipeline...", flush=True)
    df = load_data(str(input_path))
    df, features_scaled, feature_cols, weights = prepare_features(
        df, use_rolling=not args.no_rolling, window=args.window
    )
    df = run_kmeans_and_risk_levels(
        df, features_scaled, feature_cols, weights, n_clusters=args.clusters
    )

    latest_date = df["date"].max()
    df_latest = df[df["date"] == latest_date][["barangay_id", "risk_level", "cluster"]]
    df_latest.to_csv(args.output, index=False)
    print(f"Latest date: {latest_date}; wrote {len(df_latest)} rows to {args.output}", flush=True)

    # Optional: upload report to backend so users can download via frontend (no file in repo).
    backend_url = os.environ.get("BACKEND_URL", "").rstrip("/")
    if backend_url and args.upload:
        try:
            import requests
            csv_path = Path(args.output)
            if csv_path.exists():
                csv_body = csv_path.read_text(encoding="utf-8")
                url = f"{backend_url}/api/heat/davao/pipeline-report"
                headers = {"Content-Type": "text/csv"}
                key = os.environ.get("PIPELINE_REPORT_WRITER_KEY")
                if key:
                    headers["x-pipeline-report-key"] = key
                r = requests.post(url, data=csv_body, headers=headers, timeout=30)
                r.raise_for_status()
                print("Uploaded report to backend; users can download via GET /api/heat/davao/pipeline-report.", flush=True)
            else:
                print("Output file not found, skip upload.", file=sys.stderr)
        except Exception as e:
            print(f"Upload failed (report is still in {args.output}): {e}", file=sys.stderr)
            # Do not fail the pipeline; upload is optional.

    return 0


if __name__ == "__main__":
    sys.exit(main())
