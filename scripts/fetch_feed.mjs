/**
 * Builds the feed JSON that GitHub Pages serves.
 *
 *   node scripts/fetch_feed.mjs --out docs
 *
 * Runs on a schedule in .github/workflows/refresh.yml, and by hand whenever
 * you want to see what the ads would get right now.
 *
 * No dependencies. Node 20+ for global fetch.
 *
 * THE SHEET IS OPTIONAL.
 * Set SHEET_ID (env or --sheet) and the catalog's `enabled` flags and labels
 * are read from the Google Sheet the Apps Script maintains, so someone can
 * switch a market off without a commit. Leave it unset and the built-in
 * CATALOG below is used. Either way the prices come from the API, live.
 */

const API_BASE  = 'https://prod-api.154310543964.hellopublic.com';
const CREDS_URL = API_BASE + '/static/anonymoususer/credentials.json';
const FREQUENCY = 'FIFTEEN_MINUTES';

const CATALOG = {
  BTC:       { symbol:'BTC',    lane:'crypto',      label:'BTC',         name:'Bitcoin',     unit:'usd', dp:2, sdp:0 },
  ETH:       { symbol:'ETH',    lane:'crypto',      label:'ETH',         name:'Ethereum',    unit:'usd', dp:2, sdp:0 },
  SOL:       { symbol:'SOL',    lane:'crypto',      label:'SOL',         name:'Solana',      unit:'usd', dp:2, sdp:0 },
  XRP:       { symbol:'XRP',    lane:'crypto',      label:'XRP',         name:'XRP',         unit:'usd', dp:4, sdp:2 },
  BNB:       { symbol:'BNB',    lane:'crypto',      label:'BNB',         name:'BNB',         unit:'usd', dp:2, sdp:0 },
  DOGE:      { symbol:'DOGE',   lane:'crypto',      label:'DOGE',        name:'Dogecoin',    unit:'usd', dp:5, sdp:3 },
  HYPE:      { symbol:'HYPE',   lane:'crypto',      label:'HYPE',        name:'Hyperliquid', unit:'usd', dp:2, sdp:0 },
  NEAR:      { symbol:'NEAR',   lane:'crypto',      label:'NEAR',        name:'NEAR',        unit:'usd', dp:4, sdp:2 },
  ZEC:       { symbol:'ZEC',    lane:'crypto',      label:'ZEC',         name:'Zcash',       unit:'usd', dp:2, sdp:0 },

  GOLD:      { symbol:'GOLD',   lane:'commodities', label:'Gold',        name:'gold',            unit:'usd', dp:2, sdp:0 },
  SILVER:    { symbol:'SILVER', lane:'commodities', label:'Silver',      name:'silver',          unit:'usd', dp:3, sdp:2 },
  COPPER:    { symbol:'COPPER', lane:'commodities', label:'Copper',      name:'copper',          unit:'usd', dp:4, sdp:3 },
  PLATINUM:  { symbol:'PLAT',   lane:'commodities', label:'Platinum',    name:'platinum',        unit:'usd', dp:2, sdp:0 },
  PALLADIUM: { symbol:'PALL',   lane:'commodities', label:'Palladium',   name:'palladium',       unit:'usd', dp:2, sdp:0 },
  WTI:       { symbol:'WTI',    lane:'commodities', label:'WTI Oil',     name:'WTI oil',         unit:'usd', dp:2, sdp:2 },
  BRENT:     { symbol:'BRENT',  lane:'commodities', label:'Brent Crude', name:'Brent crude oil', unit:'usd', dp:2, sdp:2 },
  NATGAS:    { symbol:'NG',     lane:'commodities', label:'Natural Gas', name:'natural gas',     unit:'usd', dp:3, sdp:2 },

  EURUSD:    { symbol:'EURUSD', lane:'financials',  label:'EUR/USD',     name:'EUR/USD', unit:'fx', dp:5, sdp:4 },
  USDCAD:    { symbol:'USDCAD', lane:'financials',  label:'USD/CAD',     name:'USD/CAD', unit:'fx', dp:5, sdp:4 },
  USDJPY:    { symbol:'USDJPY', lane:'financials',  label:'USD/JPY',     name:'USD/JPY', unit:'fx', dp:3, sdp:2 },
  AUDUSD:    { symbol:'AUDUSD', lane:'financials',  label:'AUD/USD',     name:'AUD/USD', unit:'fx', dp:5, sdp:4 },
  GBPUSD:    { symbol:'GBPUSD', lane:'financials',  label:'GBP/USD',     name:'GBP/USD', unit:'fx', dp:5, sdp:4 }
};

// Windows close on fixed quarter-hour boundaries, so every market crosses this
// line at once: a build landing inside it yields nothing and exits non-zero,
// the workflow fails, and Pages keeps the previous deploy. That is the correct
// outcome -- roughly one build in eight is skipped so none is misleading.
const NEAR_CLOSE_SECONDS = 120;

const LANES = ['crypto', 'commodities', 'financials'];
const LANE_TAB = { crypto:'CRYPTO', commodities:'COMMODITIES', financials:'FINANCIALS' };

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || true])
);
const OUT_DIR  = args.out || 'docs';
const SHEET_ID = args.sheet || process.env.SHEET_ID || '';

const num = v => {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
};

async function getJwt() {
  const res = await fetch(CREDS_URL);
  if (!res.ok) throw new Error('credentials HTTP ' + res.status);
  const b = await res.json();
  const jwt = b.jwt || b.token || b.accessToken;
  if (!jwt) throw new Error('no jwt in credentials.json');
  return jwt;
}

async function apiGet(path, jwt) {
  const res = await fetch(API_BASE + path, {
    headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + path);
  return res.json();
}

/** Small concurrency cap so a 22-root refresh doesn't open 22 sockets at once. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); }
      catch (e) { out[idx] = { error: String(e.message || e) }; }
    }
  }));
  return out;
}

/* ---------------------------------------------------------------------------
 *  Optional sheet overrides. gviz honours link-sharing, so this needs no auth.
 *  A failure here is never fatal -- the built-in catalog carries on.
 * ------------------------------------------------------------------------- */
async function readSheetOverrides(sheetId) {
  const overrides = {};
  for (const lane of LANES) {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${LANE_TAB[lane]}`;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`  sheet ${LANE_TAB[lane]}: HTTP ${res.status}, ignoring`); continue; }
      const grid = parseCsv(await res.text());
      if (grid.length < 2) continue;
      const head = grid[0];
      for (const r of grid.slice(1)) {
        const row = Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']));
        if (!row.root) continue;
        overrides[row.root] = {
          enabled: !/^(false|0)$/i.test(String(row.enabled).trim()),
          label: row.label || undefined,
          name: row.name || undefined
        };
      }
    } catch (e) {
      console.warn(`  sheet ${LANE_TAB[lane]}: ${e.message}, ignoring`);
    }
  }
  return overrides;
}

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length && !(r.length === 1 && r[0] === ''));
}

/* ------------------------------------------------------------------------- */

function toMarket(root, timeline, detail) {
  const cat = CATALOG[root];
  const o = (detail.outcomes || [])[0] || {};
  const yes = (o.contracts || []).find(c => c.predictedOutcome === 'YES');
  const no  = (o.contracts || []).find(c => c.predictedOutcome === 'NO');
  const tl  = o.timeline || {};
  const target = num(o.floorStrike);

  const closeMs = Date.parse(tl.closeTime || detail.resolutionTime || '') || 0;
  const secsToClose = closeMs ? (closeMs - Date.now()) / 1000 : Infinity;

  let reason = '';
  if (detail.halted) reason = 'halted';
  else if (detail.resolved) reason = 'resolved';
  else if (o.state !== 'STATE_OPEN') reason = 'state:' + (o.state || 'unknown');
  else if (!yes || num(yes.price) == null) reason = 'no_price';
  else if (target == null) reason = 'no_strike';
  // A snapshot taken in the last two minutes of a window is poison. The odds
  // have already collapsed toward settlement -- a real 99/1 -- and this file
  // then serves for 10-25 minutes, presenting that as the state of a window
  // that has since opened fresh. Observed live: BTC and ETH both served
  // "Up 99% / Down 1%" into a brand new window. Refusing to publish it is
  // better than publishing something confidently wrong; the previous file
  // stays up and is closer to the truth.
  else if (secsToClose < NEAR_CLOSE_SECONDS) reason = `near_close:${Math.round(secsToClose)}s`;

  // Past windows, oldest first. Each settled window's floorStrike is that
  // window's opening price, so the chain of them is a 15-minute price series.
  const seen = new Set();
  const history = [...(timeline.previously || []), timeline.previous]
    .filter(Boolean)
    .map(w => ({ t: w.closeTime, v: num((w.outcomes || [])[0]?.floorStrike) }))
    .filter(h => h.t && h.v != null && !seen.has(h.t) && seen.add(h.t))
    .sort((a, b) => (a.t < b.t ? -1 : 1));

  return {
    id: detail.slug || root,          // never eventId -- that carries the exchange name
    root,
    symbol: cat.symbol,
    lane: cat.lane,
    type: 'updown',
    label: cat.label,
    name: cat.name,
    unit: cat.unit, dp: cat.dp, sdp: cat.sdp,
    open_time: tl.openTime || '',
    close_time: tl.closeTime || detail.resolutionTime || '',
    // These endpoints expose no live tick. floorStrike is the window's opening
    // price, so it is both the target and the freshest price available.
    spot: target,
    open: target,
    target,
    spot_source: 'window_open',
    up_price: num(yes?.price),
    down_price: num(no?.price),
    bid: num(yes?.bid),
    ask: num(yes?.ask),
    volume: num(detail.volume),
    low_liquidity: !!yes?.lowLiquidity,
    history,
    eligible: !reason,
    exclusion_reason: reason
  };
}

async function main() {
  const t0 = Date.now();
  const jwt = await getJwt();

  const roots = await apiGet('/eventcontractservice/recurring/events/roots', jwt);
  const published = roots.filter(r => r.frequency === FREQUENCY).map(r => r.root);
  const wanted = published.filter(r => CATALOG[r]);
  const notCatalogued = published.filter(r => !CATALOG[r]);

  let overrides = {};
  if (SHEET_ID) {
    console.log('reading sheet overrides...');
    overrides = await readSheetOverrides(SHEET_ID);
    console.log(`  ${Object.keys(overrides).length} row(s) from the sheet`);
  }

  const built = await mapLimit(wanted, 6, async root => {
    const tl = await apiGet(
      `/eventcontractservice/recurring/events/timeline?root=${encodeURIComponent(root)}&frequency=${FREQUENCY}`, jwt);
    if (!tl?.current?.eventSymbol) return { root, skipped: 'no_current_event' };
    const detail = await apiGet(
      `/eventcontractservice/event/details/${encodeURIComponent(tl.current.eventSymbol)}`, jwt);
    return { root, market: toMarket(root, tl, detail) };
  });

  const markets = [];
  const skipped = notCatalogued.map(r => `${r}:not_in_catalog`);

  for (const b of built) {
    if (b.error)   { skipped.push(`${b.root ?? '?'}:${b.error}`); continue; }
    if (b.skipped) { skipped.push(`${b.root}:${b.skipped}`); continue; }
    const ov = overrides[b.root];
    if (ov && ov.enabled === false) { skipped.push(`${b.root}:disabled_in_sheet`); continue; }
    if (ov?.label) b.market.label = ov.label;
    if (ov?.name)  b.market.name  = ov.name;
    if (!b.market.eligible) { skipped.push(`${b.root}:${b.market.exclusion_reason}`); continue; }
    markets.push(b.market);
  }

  markets.sort((a, b) =>
    LANES.indexOf(a.lane) - LANES.indexOf(b.lane) || a.symbol.localeCompare(b.symbol));

  const now = new Date();
  // The window every market in this batch closes into. Lets a creative tell a
  // genuinely current snapshot from one that outlived its window.
  const closes = markets.map(m => Date.parse(m.close_time)).filter(Boolean);
  const feed = {
    schema_version: 1,
    source: 'github_actions',
    fetched_at: now.toISOString(),
    // How long this file can be trusted. Past the soonest close every price in
    // it describes a window that has already settled.
    expires_at: closes.length ? new Date(Math.min(...closes)).toISOString() : null,
    refresh_minutes: 5,
    roots_published: published.length,
    total: markets.length,
    skipped,
    markets
  };

  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}/feed.json`, JSON.stringify(feed, null, 1));
  for (const lane of LANES) {
    await writeFile(`${OUT_DIR}/${lane}.json`, JSON.stringify(
      { ...feed, total: markets.filter(m => m.lane === lane).length,
        markets: markets.filter(m => m.lane === lane) }, null, 1));
  }

  const byLane = LANES.map(l => `${l} ${markets.filter(m => m.lane === l).length}`).join(' · ');
  console.log(`\n${markets.length} markets  (${byLane})  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (skipped.length) console.log(`skipped: ${skipped.join(' ')}`);
  console.log(`written to ${OUT_DIR}/feed.json + ${LANES.length} lane files`);

  if (!markets.length) { console.error('\nno markets built — not publishing an empty feed'); process.exit(1); }
}

main().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
