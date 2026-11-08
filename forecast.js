/**
 * Experimental short-term seismic outlook for Japan.
 *
 * Uses open USGS catalog data only. Combines:
 *  - spatial clustering of recent events
 *  - short-window rate acceleration vs 30-day baseline
 *  - Omori-style aftershock expectancy after M≥5 mainsocks
 *  - rough Gutenberg–Richter inspired M≥4 chance over the next 72h
 *
 * This is NOT an official forecast and cannot predict exact quakes.
 * Treat output as a research-style activity watch for the dashboard.
 */

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;
const CLUSTER_KM = 90;
const MIN_CLUSTER_EVENTS = 2;

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function clusterQuakes(quakes) {
  const remaining = [...quakes].sort((a, b) => b.mag - a.mag);
  const clusters = [];

  while (remaining.length) {
    const seed = remaining.shift();
    const members = [seed];
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (haversineKm(seed, remaining[i]) <= CLUSTER_KM) {
        members.push(remaining.splice(i, 1)[0]);
      }
    }
    if (members.length >= MIN_CLUSTER_EVENTS || seed.mag >= 4.5) {
      clusters.push(members);
    }
  }
  return clusters;
}

function centroid(members) {
  const lat = members.reduce((s, q) => s + q.lat, 0) / members.length;
  const lon = members.reduce((s, q) => s + q.lon, 0) / members.length;
  return { lat, lon };
}

function countInWindow(members, now, windowMs) {
  return members.filter((q) => now - q.time <= windowMs).length;
}

function maxMag(members) {
  return members.reduce((m, q) => Math.max(m, q.mag), 0);
}

function meanDepth(members) {
  return members.reduce((s, q) => s + q.depth, 0) / members.length;
}

/** Simple Omori-Utsu expected aftershock count for next horizonHours. */
function omoriExpected(mainshock, horizonHours, now) {
  if (!mainshock || mainshock.mag < 5) return 0;
  const tDays = Math.max(0.02, (now - mainshock.time) / MS_DAY);
  const p = 1.1;
  const c = 0.05;
  // Productivity scales with magnitude (very simplified).
  const k = Math.max(0.2, 0.15 * Math.pow(10, 0.75 * (mainshock.mag - 5)));
  const rate = (dt) => k / Math.pow(c + dt, p);
  // Trapezoid integrate from tDays to tDays + horizon
  const steps = 12;
  const h = horizonHours / 24 / steps;
  let sum = 0;
  for (let i = 0; i < steps; i += 1) {
    const t0 = tDays + i * h;
    const t1 = t0 + h;
    sum += 0.5 * (rate(t0) + rate(t1)) * h;
  }
  return sum;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function scoreLabel(score) {
  if (score >= 0.72) return { level: "High watch", tone: "high" };
  if (score >= 0.48) return { level: "Elevated", tone: "elevated" };
  if (score >= 0.28) return { level: "Moderate", tone: "moderate" };
  return { level: "Quiet", tone: "quiet" };
}

function regionName(lat, lon, placeHint) {
  if (placeHint && /Japan|Honshu|Hokkaido|Kyushu|Shikoku|Okinawa/i.test(placeHint)) {
    const short = placeHint.replace(/^.*,\s*/, "").trim();
    if (short.length < 48) return short;
  }
  if (lat >= 41) return "Hokkaido / northern Honshu";
  if (lat >= 36 && lon >= 139) return "Tohoku–Kanto offshore";
  if (lat >= 34 && lon < 137) return "Chubu / Sea of Japan side";
  if (lat >= 32) return "Southwest Honshu / Shikoku";
  if (lat >= 28) return "Kyushu / Ryukyu arc";
  return "Southern Ryukyu / Nansei";
}

/**
 * Build ranked forecast hotspots from a Japan quake catalog.
 * @param {Array} quakes catalog events with mag/lat/lon/depth/time/place
 */
export function buildForecast(quakes, now = Date.now()) {
  if (!quakes?.length) {
    return {
      generatedAt: now,
      horizonHours: 72,
      hotspots: [],
      summary: "Not enough open catalog events to form an outlook.",
    };
  }

  const clusters = clusterQuakes(quakes);
  const hotspots = clusters
    .map((members) => {
      const center = centroid(members);
      const latest = [...members].sort((a, b) => b.time - a.time)[0];
      const mainshock = [...members].sort((a, b) => b.mag - a.mag)[0];
      const n24 = countInWindow(members, now, MS_DAY);
      const n72 = countInWindow(members, now, 3 * MS_DAY);
      const n30 = members.length;
      const baselineDaily = n30 / 30;
      const recentDaily = n72 / 3;
      const acceleration = baselineDaily > 0 ? recentDaily / baselineDaily : recentDaily > 0 ? 3 : 0;
      const peak = maxMag(members);
      const depth = meanDepth(members);
      const omori72 = omoriExpected(mainshock.mag >= 5 ? mainshock : null, 72, now);

      // Lightweight weighted model (interpretable "AI-assisted" score).
      const score = clamp01(
        0.28 * clamp01(acceleration / 3) +
          0.22 * clamp01(n24 / 4) +
          0.2 * clamp01((peak - 3.5) / 2.5) +
          0.18 * clamp01(omori72 / 3) +
          0.12 * clamp01((40 - Math.min(depth, 40)) / 40)
      );

      // Rough next-72h chance of another M≥4 in the cluster (heuristic).
      const grChance =
        1 -
        Math.exp(
          -Math.max(
            0.02,
            0.08 * n72 * Math.pow(10, -0.9 * Math.max(0, 4 - (peak - 0.3))) + 0.35 * omori72
          )
        );

      const { level, tone } = scoreLabel(score);
      const radiusKm = Math.min(160, 45 + members.length * 8 + peak * 6);

      return {
        id: `${center.lat.toFixed(2)}_${center.lon.toFixed(2)}`,
        lat: center.lat,
        lon: center.lon,
        radiusKm,
        score,
        level,
        tone,
        chanceM4: clamp01(grChance),
        expectedAftershocks72h: omori72,
        counts: { h24: n24, h72: n72, d30: n30 },
        peakMag: peak,
        meanDepth: depth,
        acceleration,
        region: regionName(center.lat, center.lon, latest.place),
        latestPlace: latest.place,
        latestTime: latest.time,
        mainshockMag: mainshock.mag,
        mainshockTime: mainshock.time,
        members: members.length,
      };
    })
    .filter((h) => h.score >= 0.2 || h.peakMag >= 4.8)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const top = hotspots[0];
  const summary = top
    ? `Highest model watch: ${top.level} near ${top.region} (score ${(top.score * 100).toFixed(0)}). Horizon 72h · experimental.`
    : "No elevated clusters detected in the open USGS Japan window.";

  return {
    generatedAt: now,
    horizonHours: 72,
    hotspots,
    summary,
    model:
      "Cluster rate + Omori aftershock expectancy + magnitude/depth features (client-side)",
  };
}

export function forecastToneColor(tone) {
  switch (tone) {
    case "high":
      return "#c0392b";
    case "elevated":
      return "#d97706";
    case "moderate":
      return "#2f8f7b";
    default:
      return "#6aa8af";
  }
}
