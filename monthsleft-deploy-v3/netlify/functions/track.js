// netlify/functions/track.js
//
// Lightweight page-visit tracker. Called once per page load via a small
// beacon in index.html. Uses Netlify's built-in x-nf-geo header (free,
// available on every plan, no third-party analytics account needed) to
// log visits by country. Stored in the same Netlify Blobs store as the
// MCP call counters, so /stats.html shows everything in one place.
//
// Privacy note: this only ever stores aggregate counts (total visits,
// visits per day, visits per country) — never individual IPs, cookies,
// or any per-visitor identifier.

const { getStore } = require('@netlify/blobs');

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

  try {
    const { country } = decodeGeo(event);
    const day = new Date().toISOString().slice(0, 10);
    const store = getStore('stats');
    const keys = ['visits:total', `visits:day:${day}`, `visits:country:${country}`];
    await Promise.all(
      keys.map(async (k) => {
        const cur = await store.get(k, { type: 'text' });
        await store.set(k, String((parseInt(cur, 10) || 0) + 1));
      })
    );
    return { statusCode: 204, headers, body: '' };
  } catch (e) {
    // Never let a tracking failure be visible to the visitor
    console.error('track failed:', e.message);
    return { statusCode: 204, headers, body: '' };
  }
};
