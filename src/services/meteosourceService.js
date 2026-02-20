/**
 * Meteosource.com API – current weather by lat/lon.
 * Used for heat map temperatures when METEOSOURCE_API_KEY is set.
 * Docs: https://www.meteosource.com/documentation
 */

const METEOSOURCE_BASE = "https://www.meteosource.com/api/v1/free";

/**
 * Fetch current weather for a location (point endpoint).
 * @param {string} apiKey - Meteosource API key
 * @param {number} lat - Latitude (decimal)
 * @param {number} lon - Longitude (decimal)
 * @returns {Promise<{ temp_c: number, humidity?: number, feels_like?: number, summary?: string } | null>}
 */
export async function getCurrentWeather(apiKey, lat, lon) {
  if (!apiKey || lat == null || lon == null) return null;
  const url = new URL(`${METEOSOURCE_BASE}/point`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("sections", "current");
  url.searchParams.set("units", "metric");
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const data = await res.json();
  const current = data?.current;
  if (!current || typeof current.temperature !== "number") return null;

  const out = {
    temp_c: current.temperature,
    feels_like: current.feels_like,
    summary: current.summary,
  };
  if (typeof current.humidity === "number") out.humidity = current.humidity;
  return out;
}
