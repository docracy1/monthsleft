// netlify/functions/track.js
//
// Visit + engagement tracker. Called via a small beacon in index.html:
// once on page load (records a visit, its country, and whether this
// browser has been seen before), and once when the tab is hidden/closed
// (records how long the visit lasted). Stored in the same Netlify Blobs
// store as the MCP call counters, so /stats.html shows everything in one
// place.
//
// Visitor identity note: to tell "same visitor came back" from "new
// visitor," the browser generates a random ID on first visit (stored in
// localStorage) and sends it along. We store only that random ID, a visit
// count, and a first-seen date — never an IP address, email, or anything
// that identifies a real person. A different browser, device, or private/
// incognito window will look like a new visitor, and clearing site data
// resets it. Aggregate counts (total visits, visits by country/day) work
// exactly as before and don't depend on this ID at all.

const { getStore } = require('@netlify/blobs');

// Manual deploys (drag-and-drop) don't get Netlify Blobs' automatic
// environment wiring, so we fall back to explicit siteID/token if the
// BLOBS_SITE_ID and BLOBS_TOKEN environment variables are set.
function getStatsStore() {
  const opts = { name: 'stats' };
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    opts.siteID = process.env.BLOBS_SITE_ID;
    opts.token = process.env.BLOBS_TOKEN;
  }
  return getStore(opts);
}

function decodeGeo(event) {
  try {
    const header = event.headers['x-nf-geo'] || event.headers['X-Nf-Geo'];
    if (!header) return { country: 'unknown' };
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return { country: (decoded.country && decoded.country.code) || 'unknown' };
  } catch (e) {
    return { country: 'unknown' };
  }
}

async function bump(store, key, by) {
  const cur = await store.get(key, { type: 'text' });
  await store.set(key, String((parseInt(cur, 10) || 0) + (by || 1)));
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    payload = {};
  }

  // sendBeacon posts a Blob with no explicit Content-Type header sometimes,
  // and some browsers send text/plain — parse defensively either way, we
  // already tolerate empty/invalid bodies above.

  const visitorId =
    typeof payload.visitor_id === 'string' && payload.visitor_id.length > 0
      ? payload.visitor_id.slice(0, 64)
      : null;
  const day = new Date().toISOString().slice(0, 10);
  const store = getStatsStore();

  try {
    if (payload.type === 'duration') {
      // Cap at 6h and ignore junk/negative values — this is a lightweight
      // engagement signal, not a precise timer.
      const ms = Math.max(0, Math.min(Number(payload.ms) || 0, 6 * 60 * 60 * 1000));
      if (ms > 0) {
        await Promise.all([
          bump(store, 'duration:total_ms', ms),
          bump(store, 'duration:count', 1),
          bump(store, `duration:day:${day}:total_ms`, ms),
          bump(store, `duration:day:${day}:count`, 1),
        ]);
      }
      return { statusCode: 204, headers, body: '' };
    }

    // Default: a page-view/visit event.
    const { country } = decodeGeo(event);
    const tasks = [
      bump(store, 'visits:total'),
      bump(store, `visits:day:${day}`),
      bump(store, `visits:country:${country}`),
    ];

    if (visitorId) {
      const seenKey = `visitor:${visitorId}`;
      const seen = await store.get(seenKey, { type: 'text' });
      if (seen) {
        tasks.push(bump(store, 'visitors:returning'));
        tasks.push(store.set(seenKey, String((parseInt(seen, 10) || 1) + 1)));
      } else {
        tasks.push(bump(store, 'visitors:unique'));
        tasks.push(store.set(seenKey, '1'));
      }
    }

    await Promise.all(tasks);
    return { statusCode: 204, headers, body: '' };
  } catch (e) {
    // Never let a tracking failure be visible to the visitor
    console.error('track failed:', e.message);
    return { statusCode: 204, headers, body: '' };
  }
};
