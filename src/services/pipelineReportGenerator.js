/**
 * In-process pipeline report generator (same logic as ai/weighted_heat_risk_pipeline.py).
 * Builds feature matrix (temp, facility_score, density), MinMaxScale, K-Means k=5, rank clusters → PAGASA levels 1–5.
 * Used by POST /api/heat/:cityId/pipeline-report/generate so the frontend can trigger report generation.
 */

/**
 * MinMax scaling: each column scaled to [0, 1]. If max === min, column becomes 0.
 * @param {number[][]} matrix - Rows of feature vectors
 * @returns {number[][]} Scaled matrix (same shape)
 */
function minMaxScale(matrix) {
  if (matrix.length === 0) return matrix;
  const cols = matrix[0].length;
  const mins = [];
  const maxs = [];
  for (let c = 0; c < cols; c++) {
    let min = matrix[0][c];
    let max = matrix[0][c];
    for (let r = 1; r < matrix.length; r++) {
      const v = matrix[r][c];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    mins.push(min);
    maxs.push(max);
  }
  return matrix.map((row) =>
    row.map((v, c) => {
      const range = maxs[c] - mins[c];
      return range === 0 ? 0 : (v - mins[c]) / range;
    })
  );
}

/**
 * Seeded simple RNG for reproducible K-Means init (same as Python random_state=42).
 */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Euclidean distance squared between two vectors.
 */
function distSq(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/**
 * K-Means k=5, deterministic init (first 5 rows then shuffle with seed 42 for parity with Python).
 * Returns cluster index per row (0..4).
 * @param {number[][]} scaled - MinMax-scaled feature matrix
 * @param {number} k
 * @param {number} seed
 * @returns {number[]} assignments
 */
function kmeans(scaled, k = 5, seed = 42) {
  const n = scaled.length;
  if (n === 0) return [];
  const dim = scaled[0].length;

  const rng = mulberry32(seed);
  const indices = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  let centroids = indices.slice(0, k).map((i) => [...scaled[i]]);

  let assignments = new Array(n).fill(0);
  for (let iter = 0; iter < 100; iter++) {
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = distSq(scaled[i], centroids[0]);
      for (let j = 1; j < k; j++) {
        const d = distSq(scaled[i], centroids[j]);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      next[i] = best;
    }
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (next[i] !== assignments[i]) changed = true;
      assignments[i] = next[i];
    }
    if (!changed) break;

    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let d = 0; d < dim; d++) sums[c][d] += scaled[i][d];
    }
    for (let j = 0; j < k; j++) {
      if (counts[j] > 0) {
        for (let d = 0; d < dim; d++) centroids[j][d] = sums[j][d] / counts[j];
      }
    }
  }
  return assignments;
}

/**
 * Build pipeline report CSV (barangay_id, risk_level, cluster) from feature rows.
 * Same methodology as ai/weighted_heat_risk_pipeline.py: EWA weights, K-Means k=5, rank by weighted mean → PAGASA 1–5.
 *
 * @param {Array<{ barangay_id: string, temp: number, facility_score: number, density: number }>} rows
 * @returns {string} CSV content
 */
export function runPipelineReport(rows) {
  if (rows.length === 0) {
    return "barangay_id,risk_level,cluster\n";
  }

  const hasDensity = rows.some((r) => Number(r.density) > 0);
  const featureCols = hasDensity ? ["temp", "facility_score", "density"] : ["temp", "facility_score"];
  const weights = hasDensity ? [1 / 3, 1 / 3, 1 / 3] : [0.5, 0.5];

  const matrix = rows.map((r) =>
    featureCols.map((col) => (col === "temp" ? r.temp : col === "facility_score" ? r.facility_score : r.density ?? 0))
  );
  const scaled = minMaxScale(matrix);
  const assignments = kmeans(scaled, 5, 42);

  const clusterToMean = {};
  for (let i = 0; i < rows.length; i++) {
    const c = assignments[i];
    if (!clusterToMean[c]) clusterToMean[c] = { sum: 0, n: 0 };
    const severity = scaled[i].reduce((s, v, j) => s + v * weights[j], 0);
    clusterToMean[c].sum += severity;
    clusterToMean[c].n += 1;
  }
  const clusterMeans = Object.keys(clusterToMean).map(Number).map((c) => ({
    cluster: c,
    mean: clusterToMean[c].n ? clusterToMean[c].sum / clusterToMean[c].n : 0,
  }));
  clusterMeans.sort((a, b) => a.mean - b.mean);
  const clusterToLevel = {};
  clusterMeans.forEach(({ cluster }, idx) => {
    clusterToLevel[cluster] = idx + 1;
  });

  const lines = ["barangay_id,risk_level,cluster"];
  for (let i = 0; i < rows.length; i++) {
    const level = clusterToLevel[assignments[i]] ?? 1;
    lines.push(`${rows[i].barangay_id},${level},${assignments[i]}`);
  }
  return lines.join("\n") + "\n";
}
