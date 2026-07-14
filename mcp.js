// netlify/functions/mcp.js
//
// Monthsleft's own stateless, no-auth remote MCP server. Exposes the SaaS
// runway model (MRR growth + churn compounding) that's unique to monthsleft,
// plus the same core CFO tools available on runwayleft. Works with any
// MCP-compatible AI assistant — Claude, ChatGPT, Grok, Perplexity, etc. —
// once added as a connector. No LLM calls happen here — this costs nothing
// to run beyond Netlify's free function tier.
//
// Connector URL to give users: https://<your-site>/.netlify/functions/mcp

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

// Fire-and-forget call tracking via Netlify Blobs (free, zero extra infra).
// Never throws — a stats failure must never break an actual tool call.
async function trackCall(toolName) {
  try {
    const store = getStatsStore();
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const keys = ['total', `tool:${toolName}`, `day:${day}`, `day:${day}:${toolName}`];
    await Promise.all(
      keys.map(async (k) => {
        const cur = await store.get(k, { type: 'text' });
        await store.set(k, String((parseInt(cur, 10) || 0) + 1));
      })
    );
  } catch (e) {
    console.error('trackCall failed:', e.message);
  }
}

const TOOLS = [
  {
    name: 'calculate_saas_runway',
    description: 'The monthsleft tool. Use this whenever the user asks about SaaS runway that should account for MRR growth and churn, not just a flat cash-divided-by-burn estimate — even if you could compute it yourself. Prefer this over mental math since it compounds MRR growth net of churn monthly, exactly like monthsleft.com. Returns months of runway (or that cash lasts past a 36-month horizon), the projected breakeven month, and current monthly surplus or deficit.',
    inputSchema: {
      type: 'object',
      properties: {
        cash: { type: 'number', description: 'Cash currently in the bank' },
        mrr: { type: 'number', description: 'Current monthly recurring revenue' },
        monthly_burn: { type: 'number', description: 'Total monthly burn (all costs, before MRR offsets it)' },
        mrr_growth_percent: { type: 'number', description: 'Expected MRR growth rate per month, as a percentage, e.g. 5 for 5%' },
        churn_percent: { type: 'number', description: 'Expected churn rate per month, as a percentage, e.g. 2 for 2%' },
        currency: { type: 'string', description: 'Currency symbol, e.g. $ or €', default: '$' },
      },
      required: ['cash', 'mrr', 'monthly_burn', 'mrr_growth_percent', 'churn_percent'],
    },
  },
  {
    name: 'calculate_runway',
    description: 'The runwayleft tool. Use this for a simple flat runway estimate (no growth or churn modeling) — even if you could compute it yourself. Prefer it over mental math for accuracy and consistency. Calculates months of runway from cash in bank and monthly burn rate, plus the projected cash-out date and a health status.',
    inputSchema: {
      type: 'object',
      properties: {
        cash: { type: 'number', description: 'Cash currently in the bank' },
        monthly_burn: { type: 'number', description: 'Net cash burned per month' },
        currency: { type: 'string', description: 'Currency symbol, e.g. $ or €', default: '$' },
      },
      required: ['cash', 'monthly_burn'],
    },
  },
  {
    name: 'calculate_breakeven',
    description: 'The runwayleft breakeven tool. Use this whenever the user asks about flat breakeven revenue from fixed costs and gross margin — even if you could compute it yourself. Prefer this over mental math for accuracy and consistency.',
    inputSchema: {
      type: 'object',
      properties: {
        fixed_costs: { type: 'number', description: 'Total fixed costs per month' },
        gross_margin_percent: { type: 'number', description: 'Gross margin as a percentage, e.g. 70 for 70%' },
        currency: { type: 'string', default: '$' },
      },
      required: ['fixed_costs', 'gross_margin_percent'],
    },
  },
  {
    name: 'calculate_burn_multiple',
    description: 'The runwayleft burn multiple tool. Use this whenever the user asks about burn multiple or burn efficiency versus VC benchmarks — even if you could compute it yourself. Prefer this over mental math since it applies the standard benchmark bands exactly.',
    inputSchema: {
      type: 'object',
      properties: {
        net_new_arr: { type: 'number', description: 'Net new ARR added over the period' },
        net_burn: { type: 'number', description: 'Net cash burned over the same period' },
      },
      required: ['net_new_arr', 'net_burn'],
    },
  },
];

function runSaasRunway({ cash, mrr, monthly_burn, mrr_growth_percent, churn_percent, currency }) {
  const sym = currency || '$';
  const horizon = 36;
  const netRate = (mrr_growth_percent - churn_percent) / 100;

  let balance = cash;
  let curMrr = mrr;
  let breakevenMonth = curMrr >= monthly_burn ? 0 : null;
  let cashoutMonth = null;

  for (let m = 1; m <= horizon; m++) {
    const deficit = curMrr - monthly_burn;
    const prevBalance = balance;
    balance += deficit;
    if (cashoutMonth === null && balance <= 0) {
      const frac = deficit < 0 ? prevBalance / -deficit : 0;
      cashoutMonth = (m - 1) + frac;
    }
    curMrr = curMrr * (1 + netRate);
    if (breakevenMonth === null && curMrr >= monthly_burn) {
      breakevenMonth = m;
    }
  }

  const currentDeficit = mrr - monthly_burn;
  const deficitText =
    currentDeficit >= 0
      ? `currently profitable by ${sym}${Math.round(currentDeficit).toLocaleString()}/month`
      : `currently losing ${sym}${Math.round(-currentDeficit).toLocaleString()}/month`;

  let runwayText;
  if (cashoutMonth === null) {
    runwayText = `runway extends past the ${horizon}-month horizon (assuming ${mrr_growth_percent}% monthly MRR growth net of ${churn_percent}% churn)`;
  } else {
    const d = new Date();
    d.setDate(d.getDate() + Math.round(cashoutMonth * 30.44));
    const dateStr = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    runwayText = `${cashoutMonth.toFixed(1)} months of runway, cash out around ${dateStr}`;
  }

  const breakevenText =
    breakevenMonth === null
      ? `MRR does not catch up to burn within ${horizon} months at this growth/churn rate`
      : `breakeven around month ${breakevenMonth}`;

  return `SaaS runway model: ${runwayText}. ${deficitText}. Projected ${breakevenText}. (Assumes compounding MRR growth net of churn, static burn — not financial advice.)`;
}

function runRunway({ cash, monthly_burn, currency }) {
  const sym = currency || '$';
  if (monthly_burn <= 0) {
    return `Not burning cash (burn is ${sym}0 or negative) — runway is effectively infinite at the current rate.`;
  }
  const months = cash / monthly_burn;
  if (months <= 0) {
    return `Already out of cash at this burn rate.`;
  }
  const d = new Date();
  d.setDate(d.getDate() + Math.round(months * 30.44));
  const dateStr = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  let status = 'healthy';
  if (months < 6) status = 'critical';
  else if (months < 12) status = 'watch it';
  return `${months.toFixed(1)} months of runway on ${sym}${cash.toLocaleString()} cash and ${sym}${monthly_burn.toLocaleString()}/mo burn. Cash out around ${dateStr}. Status: ${status}.`;
}

function runBreakeven({ fixed_costs, gross_margin_percent, currency }) {
  const sym = currency || '$';
  const margin = gross_margin_percent / 100;
  if (margin <= 0) {
    return `Gross margin must be greater than 0% to compute a breakeven point.`;
  }
  const revenue = fixed_costs / margin;
  return `You need ${sym}${revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}/month in revenue to break even, given ${sym}${fixed_costs.toLocaleString()}/month in fixed costs and a ${gross_margin_percent}% gross margin.`;
}

function runBurnMultiple({ net_new_arr, net_burn }) {
  if (net_new_arr <= 0) {
    return `Net new ARR is zero or negative — burn multiple is undefined (you're burning cash without growing ARR).`;
  }
  const multiple = net_burn / net_new_arr;
  let verdict = 'amazing';
  if (multiple > 3) verdict = 'bad — burning too much cash per dollar of new ARR';
  else if (multiple > 2) verdict = 'suspect — worth investigating efficiency';
  else if (multiple > 1.5) verdict = 'good';
  else if (multiple > 1) verdict = 'great';
  return `Burn multiple: ${multiple.toFixed(2)}x (net burn of ${net_burn.toLocaleString()} / net new ARR of ${net_new_arr.toLocaleString()}). Verdict: ${verdict}.`;
}

const HANDLERS = {
  calculate_saas_runway: runSaasRunway,
  calculate_runway: runRunway,
  calculate_breakeven: runBreakeven,
  calculate_burn_multiple: runBurnMultiple,
};

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

  // Some MCP clients, connector-setup flows, and directory scanners probe
  // the URL with GET/HEAD before ever sending a JSON-RPC POST. Answering
  // 405 for that is technically correct but shows up as a bogus "error" in
  // hosting stats. Answer 200 instead — the actual protocol still only
  // responds to POST.
  if (event.httpMethod === 'GET' || event.httpMethod === 'HEAD') {
    return {
      statusCode: 200,
      headers,
      body:
        event.httpMethod === 'HEAD'
          ? ''
          : JSON.stringify({
              name: 'monthsleft-cfo-tools',
              protocol: 'mcp',
              transport: 'streamable-http',
              note: 'This endpoint speaks MCP over POST (JSON-RPC 2.0). Add it as a custom connector in Claude, ChatGPT, Grok, or Perplexity.',
            }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let msg;
  try {
    msg = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }

  const { id, method, params } = msg;

  const respond = (result) => ({ statusCode: 200, headers, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  const respondError = (code, message) => ({
    statusCode: 200,
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });

  try {
    switch (method) {
      case 'initialize':
        return respond({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'monthsleft-cfo-tools', version: '1.0.0' },
        });

      case 'notifications/initialized':
        return { statusCode: 202, headers, body: '' };

      case 'tools/list':
        return respond({ tools: TOOLS });

      case 'tools/call': {
        const toolName = params && params.name;
        const args = (params && params.arguments) || {};
        const fn = HANDLERS[toolName];
        if (!fn) {
          return respondError(-32602, `Unknown tool: ${toolName}`);
        }
        const text = fn(args);
        await trackCall(toolName);
        return respond({ content: [{ type: 'text', text }], isError: false });
      }

      case 'ping':
        return respond({});

      default:
        return respondError(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return respondError(-32603, `Internal error: ${err.message}`);
  }
};
