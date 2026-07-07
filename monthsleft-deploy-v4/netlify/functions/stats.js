// netlify/functions/stats.js
//
// Read-only endpoint that returns MCP tool-call counters tracked in
// netlify/functions/mcp.js via Netlify Blobs. Free, no extra infra.
//
// Optional lightweight privacy: set a STATS_KEY environment variable in
// Netlify site settings, then visit /.netlify/functions/stats?key=<value>.
// If STATS_KEY is unset, the endpoint is open — fine for a low-stakes
// calculator, but set it if you don't want randoms scraping your numbers.

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

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const secret = process.env.STATS_KEY;
  if (secret && (event.queryStringParameters || {}).key !== secret) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const store = getStatsStore();
    const { blobs } = await store.list();
    const data = {};
    await Promise.all(
      blobs.map(async (b) => {
        const val = await store.get(b.key, { type: 'text' });
        data[b.key] = parseInt(val, 10) || 0;
      })
    );
    return { statusCode: 200, headers, body: JSON.stringify(data, null, 2) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
