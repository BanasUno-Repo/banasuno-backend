/**
 * Match PSA 2020 population data to Davao barangays (by GeoJSON name) and compute density.
 * Used by heat risk assessment to include population/urban density per barangay.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getDavaoBarangayGeo } from "./barangays.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedPopulationByBarangayId = null;

function getBarangayId(feature) {
  if (!feature) return null;
  const id = feature.id ?? feature.properties?.adm4_psgc ?? feature.properties?.ADM4_PSGC;
  return id != null ? String(id) : null;
}

/**
 * Load population JSON from data/davao-city-population.json (PSA 2020 census).
 * @returns {{ barangays: Array<{ barangay: string, population: number, barangay_normalized: string }> }}
 */
function loadPopulationData() {
  const path = join(__dirname, "..", "..", "data", "davao-city-population.json");
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

/**
 * Build a map of barangay ID (PSGC) -> { population, density } by matching GeoJSON adm4_en to census barangay_normalized.
 * Density = population / area_km2 (from GeoJSON); missing or zero area yields density 0.
 * @returns {Promise<{ [barangayId: string]: { population: number, density: number } }>}
 */
export async function getPopulationDensityByBarangayId() {
  if (cachedPopulationByBarangayId) return cachedPopulationByBarangayId;

  const geo = await getDavaoBarangayGeo();
  const popData = loadPopulationData();

  const byNormalizedName = new Map();
  for (const b of popData.barangays || []) {
    const name = (b.barangay_normalized ?? b.barangay ?? "").trim();
    if (name) byNormalizedName.set(name, Number(b.population) || 0);
  }

  const result = {};
  for (const f of geo?.features || []) {
    const id = getBarangayId(f);
    const name = (f.properties?.adm4_en ?? f.properties?.name ?? "").trim();
    const areaKm2 = Number(f.properties?.area_km2) || 0;
    if (!id) continue;

    const population = byNormalizedName.get(name) ?? 0;
    const density = areaKm2 > 0 ? population / areaKm2 : 0;

    result[id] = { population, density };
  }

  cachedPopulationByBarangayId = result;
  return result;
}
