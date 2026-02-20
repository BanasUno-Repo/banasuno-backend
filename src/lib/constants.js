/**
 * Shared constants used by routes and scripts.
 * Single source of truth to avoid drift (e.g. Redis key, URLs).
 */

/** Redis key for Davao health facilities list (JSON array). */
export const FACILITIES_KEY = "health:facilities:davao";

/** Redis key for latest pipeline heat-risk report CSV (uploaded by pipeline script; served for download). */
export const PIPELINE_REPORT_KEY = "pipeline:heat_risk_report";
/** Redis key for pipeline report last-updated timestamp (ISO string). */
export const PIPELINE_REPORT_UPDATED_KEY = "pipeline:heat_risk_updated_at";
