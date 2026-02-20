/**
 * Heat-risk model (rule-based).
 * Validated path: NOAA Rothfusz heat index (NWS SR 90-23) when humidity is available → PAGASA categories.
 * Fallback: air temperature (°C) → PAGASA categories.
 * PAGASA: https://www.pagasa.dost.gov.ph/weather/heat-index
 *
 * PAGASA categories (heat index °C):
 *   Not Hazardous:  < 27°C
 *   Caution:        27–32°C
 *   Extreme Caution: 33–41°C
 *   Danger:         42–51°C
 *   Extreme Danger: ≥ 52°C
 */
import { heatIndexRothfusz } from "../lib/heatIndex.js";

function round1(x) {
  return Math.round(x * 10) / 10;
}

/** PAGASA-based heat index levels (5 categories). Source: https://www.pagasa.dost.gov.ph/weather/heat-index */
export const HEAT_LEVELS = [
  { level: 1, label: "Not Hazardous", range: "< 27°C", color: "#48bb78" },
  { level: 2, label: "Caution", range: "27–32°C", color: "#ecc94b" },
  { level: 3, label: "Extreme Caution", range: "33–41°C", color: "#ed8936" },
  { level: 4, label: "Danger", range: "42–51°C", color: "#f97316" },
  { level: 5, label: "Extreme Danger", range: "≥ 52°C", color: "#dc2626" },
];

/**
 * Map air temperature (°C) to PAGASA category and a normalized score [0, 1].
 * Bands: <27, 27–32, 33–41, 42–51, ≥52.
 */
function tempToPAGASALevel(tempC) {
  const t = tempC;
  if (t < 27) return { level: 1, label: "Not Hazardous", score: 0.1 };
  if (t <= 32) return { level: 2, label: "Caution", score: 0.2 + ((t - 27) / 5) * 0.2 };
  if (t <= 41) return { level: 3, label: "Extreme Caution", score: 0.4 + ((t - 33) / 8) * 0.2 };
  if (t <= 51) return { level: 4, label: "Danger", score: 0.6 + ((t - 42) / 9) * 0.2 };
  return { level: 5, label: "Extreme Danger", score: 0.8 + Math.min(0.2, (t - 52) / 20) };
}

/**
 * Assess heat risk per barangay using PAGASA heat index categories.
 * Score uses only validated inputs: heat index (or air temp) → PAGASA level → score = (level − 1) / 4.
 * No delta or density in score; delta_c, population, density are reported for information only.
 *
 * @param {{ [barangayId: string]: number }} temperatures - Barangay-level temps (°C), e.g. from Meteosource
 * @param {{ averageTemp?: number, humidityByBarangay?: { [id: string]: number }, populationDensityByBarangay?: { [id: string]: { population: number, density: number } } }} opts - Optional city average (for delta_c only); optional RH % (enables validated NOAA heat index); optional population/density (reported only)
 * @returns {{
 *   risks: { [barangayId: string]: { score: number, level: number, label: string, temp_c: number, heat_index_c?: number, delta_c: number, population?: number, density?: number } },
 *   averageTemp: number | undefined,
 *   minScore: number | undefined,
 *   maxScore: number | undefined,
 *   counts: object,
 *   legend: array,
 *   basis: string,
 *   usedHeatIndex: boolean
 * }}
 */
/** Score from validated level only: level 1→0, 2→0.25, 3→0.5, 4→0.75, 5→1 (no delta/density in score). */
function scoreFromLevel(level) {
  return (level - 1) / 4;
}

export function assessBarangayHeatRisk(temperatures, opts = {}) {
  const entries = Object.entries(temperatures || {}).filter(([, v]) => typeof v === "number");
  const computedAvg =
    entries.length ? entries.reduce((sum, [, v]) => sum + v, 0) / entries.length : undefined;
  const avg = typeof opts.averageTemp === "number" ? opts.averageTemp : computedAvg;
  const humidityByBarangay = opts.humidityByBarangay || {};
  const popDensity = opts.populationDensityByBarangay || {};

  let usedHeatIndex = false;
  const risks = {};
  const counts = { not_hazardous: 0, caution: 0, extreme_caution: 0, danger: 0, extreme_danger: 0 };
  const countKey = (label) => label.toLowerCase().replace(/\s+/g, "_");
  let minScore;
  let maxScore;

  for (const [id, temp] of entries) {
    const rh = humidityByBarangay[id];
    const useHi = typeof rh === "number" && rh >= 0 && rh <= 100;
    const inputForPAGASA = useHi ? heatIndexRothfusz(temp, rh) : temp;
    if (useHi) usedHeatIndex = true;

    const pagasa = tempToPAGASALevel(inputForPAGASA);
    const score = scoreFromLevel(pagasa.level);
    const delta = typeof avg === "number" ? temp - avg : 0;
    const pd = popDensity[id];

    risks[id] = {
      score: round1(score),
      level: pagasa.level,
      label: pagasa.label,
      temp_c: round1(temp),
      ...(useHi ? { heat_index_c: round1(inputForPAGASA) } : {}),
      delta_c: round1(delta),
      ...(pd ? { population: pd.population, density: round1(pd.density) } : {}),
    };

    counts[countKey(pagasa.label)] += 1;
    minScore = minScore == null ? score : Math.min(minScore, score);
    maxScore = maxScore == null ? score : Math.max(maxScore, score);
  }

  const basis =
    usedHeatIndex
      ? "NOAA Rothfusz (NWS SR 90-23) → PAGASA level → score = (level−1)/4. Refs: docs/HEAT-RISK-MODEL-BASIS.md"
      : "PAGASA level (air temp) → score = (level−1)/4. Add humidity for validated heat index. Refs: docs/HEAT-RISK-MODEL-BASIS.md";

  return {
    risks,
    averageTemp: typeof avg === "number" ? round1(avg) : undefined,
    minScore: minScore == null ? undefined : round1(minScore),
    maxScore: maxScore == null ? undefined : round1(maxScore),
    counts,
    legend: HEAT_LEVELS,
    basis,
    usedHeatIndex,
  };
}

