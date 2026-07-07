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
    const store = getStore('stats');
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
