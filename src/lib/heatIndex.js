/**
 * NOAA / NWS heat index (apparent temperature) – Rothfusz regression.
 * Validated formula: NWS Technical Attachment SR 90-23 (Lans P. Rothfusz, 1990).
 * Source: https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
 *
 * Input: air temperature (°C), relative humidity (%).
 * Output: heat index (°C). When HI would be below ~27°C we return the input temperature
 * so that low-HI cases do not use the (invalid) regression.
 */

/**
 * Compute heat index (apparent temperature) from air temperature and relative humidity.
 * Uses NOAA Rothfusz equation (T and HI in °F in the formula); converts to/from °C.
 *
 * @param {number} tempC - Air temperature in Celsius
 * @param {number} relativeHumidityPercent - Relative humidity, 0–100
 * @returns {number} Heat index in Celsius (or tempC when formula not applicable)
 */
export function heatIndexRothfusz(tempC, relativeHumidityPercent) {
  const rh = Math.min(100, Math.max(0, Number(relativeHumidityPercent)));
  const T = (Number(tempC) * 9) / 5 + 32; // Celsius to Fahrenheit

  // Simple formula for low heat index (Steadman-consistent). Result averaged with T.
  // HI_simple = 0.5 * { T + 61 + (T-68)*1.2 + (RH*0.094) }
  const simpleHi = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094);
  const averaged = (simpleHi + T) * 0.5;

  if (averaged < 80) {
    // Below 80°F use simple result (averaged with temperature)
    return ((averaged - 32) * 5) / 9;
  }

  // Full Rothfusz regression (valid for HI >= 80°F)
  // HI = -42.379 + 2.04901523*T + 10.14333127*RH - .22475541*T*RH - .00683783*T^2 - .05481717*RH^2 + .00122874*T^2*RH + .00085282*T*RH^2 - .00000199*T^2*RH^2
  let hi =
    -42.379 +
    2.04901523 * T +
    10.14333127 * rh -
    0.22475541 * T * rh -
    0.00683783 * T * T -
    0.05481717 * rh * rh +
    0.00122874 * T * T * rh +
    0.00085282 * T * rh * rh -
    0.00000199 * T * T * rh * rh;

  // Low humidity adjustment: if RH < 13% and 80 <= T <= 112, subtract
  if (rh < 13 && T >= 80 && T <= 112) {
    const adj = ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    hi -= adj;
  }
  // High humidity adjustment: if RH > 85% and 80 <= T <= 87, add
  if (rh > 85 && T >= 80 && T <= 87) {
    const adj = ((rh - 85) / 10) * ((87 - T) / 5);
    hi += adj;
  }

  const hiC = ((hi - 32) * 5) / 9;
  // Clamp to reasonable range; if formula produced absurd value, fall back to temp
  if (Number.isFinite(hiC) && hiC >= -20 && hiC <= 60) return hiC;
  return tempC;
}
