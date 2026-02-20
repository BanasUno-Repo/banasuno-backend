/**
 * Short disclaimers, sources, and validity notes for API responses.
 * Full text: docs/DISCLAIMERS.md and docs/CITED-SOURCES.md.
 */

/** Barangay temperatures (heat map data) – for GET /api/heat/:cityId/barangay-temperatures */
export const TEMPERATURES_DISCLAIMER = "Temperatures from Meteosource or WeatherAPI. For planning and awareness only; not official PAGASA or NWS observations.";
export const TEMPERATURES_SOURCES = ["Meteosource (per-point) or WeatherAPI (city center). See meta or response."];
export const TEMPERATURES_VALIDITY = "Model/API outputs; not a substitute for official heat advisories or local weather stations. See docs/DISCLAIMERS.md.";

/** Forecast – for GET /api/heat/:cityId/forecast */
export const FORECAST_DISCLAIMER = "Forecast from WeatherAPI. For general planning only; not from PAGASA or NWS. Do not rely for official warnings.";
export const FORECAST_SOURCES = ["WeatherAPI (https://www.weatherapi.com)."];
export const FORECAST_VALIDITY = "Third-party provider; not for critical or regulatory decisions. See docs/DISCLAIMERS.md.";

/** Barangay heat risk (map) – for GET /api/heat/:cityId/barangay-heat-risk */
export const HEAT_RISK_DISCLAIMER = "Risk levels use PAGASA bands and, when humidity is available, NOAA heat index. For planning and awareness only; not official PAGASA advisories.";

export const HEAT_RISK_SOURCES = [
  "Temperature/weather: Meteosource or WeatherAPI (see meta.temperaturesSource).",
  "Heat index: NOAA Rothfusz (NWS SR 90-23).",
  "Risk levels: PAGASA heat index classification.",
];

export const HEAT_RISK_VALIDITY = "When usedHeatIndex is true, level and score are from validated methods (NOAA + PAGASA). When only air temp is used, same bands apply but not full PAGASA heat index. Not for regulatory or official hazard use.";

/** Pipeline report (generate/download) – for POST .../generate and GET .../pipeline-report/meta */
export const PIPELINE_REPORT_DISCLAIMER = "Report uses temperature (or heat index), facility access, and population density with K-Means and equal weights. For planning and prioritization only; not an official health or hazard report.";

export const PIPELINE_REPORT_SOURCES = [
  "Temperature/heat index: same as heat map (Meteosource or WeatherAPI).",
  "Facility score: 1/(1+facility_count) from backend facilities data.",
  "Population/density: PSA 2020 census + GeoJSON area.",
  "Method: docs/PIPELINE-COMPUTATIONAL-BASIS.md.",
];

export const PIPELINE_REPORT_VALIDITY = "Validated: heat index (NOAA), PAGASA bands, EWA weighting. Standard: K-Means, MinMaxScaler. Do not use as sole basis for resource allocation or regulatory decisions. See docs/DISCLAIMERS.md.";
