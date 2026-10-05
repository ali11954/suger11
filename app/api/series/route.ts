import { NextResponse } from 'next/server';

const SYMBOL = 'SB=F';
const MAX_BARS = 1600;

export type Granularity = 'intraday' | 'hourly' | 'daily';

const PRESETS = ['1d', '5d', '1mo', '3mo', '1y', '5y'] as const;
type Preset = (typeof PRESETS)[number];

const RANGE_CONFIG: Record<Preset, { yahoo: string; interval: string; granularity: Granularity }> = {
  '1d': { yahoo: 'range=1d', interval: '5m', granularity: 'intraday' },
  '5d': { yahoo: 'range=5d', interval: '1h', granularity: 'hourly' },
  '1mo': { yahoo: 'range=1mo', interval: '1d', granularity: 'daily' },
  '3mo': { yahoo: 'range=3mo', interval: '1d', granularity: 'daily' },
  '1y': { yahoo: 'range=1y', interval: '1d', granularity: 'daily' },
  '5y': { yahoo: 'range=5y', interval: '1d', granularity: 'daily' },
};

const HORIZON: Record<Granularity, number> = { intraday: 24, hourly: 12, daily: 12 };

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const allNums = (arr: unknown): number[] =>
  Array.isArray(arr) ? arr.map(num).filter((v): v is number => v !== null) : [];

function intervalForSpan(days: number): string {
  if (days <= 1) return '5m';
  if (days <= 7) return '1h';
  if (days <= 60) return '1d';
  if (days <= 730) return '1wk';
  return '1mo';
}

function granularityFor(interval: string): Granularity {
  if (/m$/.test(interval) && interval !== '1mo') return 'intraday';
  if (interval === '1h') return 'hourly';
  return 'daily';
}

type CacheEntry = { at: number; body: unknown };
const cache = new Map<string, CacheEntry>();

const TTL: Record<Granularity, number> = { intraday: 20_000, hourly: 120_000, daily: 600_000 };
const STALE_MAX = 30 * 60_000;

const SNAPSHOT_CACHE_MS = 60_000;
let snap: { at: number; data: any } | null = null;

async function readSnapshot() {
  if (snap && Date.now() - snap.at < SNAPSHOT_CACHE_MS) return snap.data;
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const data = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'contracts.json'), 'utf8'));
  snap = { at: Date.now(), data };
  return data;
}

const LIMIT_BY_RANGE: Record<string, number> = { '1d': 40, '5d': 40, '1mo': 22, '3mo': 40, '1y': 40, '5y': 40 };

/**
 * Series for the nearest upcoming ICE Sugar No.11 delivery month.
 *
 * Yahoo only serves the rolled continuous ticker (SB=F) and 404s on individual
 * months, so per-contract history comes from the Stooq snapshot written by
 * `npm run fetch:contracts`. Roll-over is resolved on every request.
 */
async function nearContractSeries(range: string, from: string | null, to: string | null) {
  const { resolveNear, rollHint } = await import('../../../lib/iceCalendar');
  const data = await readSnapshot();
  const priced = (data.contracts ?? []).filter((c: any) => c.role !== 'cash' && c.available && Array.isArray(c.history) && c.history.length);
  const near = resolveNear(priced.map((c: any) => c.symbol));
  if (!near) {
    return NextResponse.json(
      { error: 'No priced delivery month in the snapshot. Run: npm run fetch:contracts', updatedAt: new Date().toISOString(), points: [] },
      { status: 503 },
    );
  }

  const row = priced.find((c: any) => c.symbol === near.symbol);
  let bars: { t: string; o: number | null; h: number | null; l: number | null; c: number }[] = row.history.filter(
    (p: any) => p && p.t && typeof p.c === 'number',
  );

  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    bars = bars.filter((b) => b.t >= from && b.t <= to);
  } else {
    bars = bars.slice(-(LIMIT_BY_RANGE[range] ?? 40));
  }

  const points = bars.map((b) => ({ t: Math.floor(Date.parse(`${b.t}T00:00:00Z`) / 1000), c: b.c, o: b.o, h: b.h, l: b.l }));
  const values = points.map((x) => x.c);
  const last = row.last ?? values[values.length - 1] ?? null;
  const base = values.length > 1 ? values[0] : null;
  const fit = leastSquares(values);
  const horizon = Math.min(Math.max(values.length - 1, 1), 12);
  const projected = fit ? fit.slope * (values.length - 1 + horizon) + fit.intercept : null;

  return NextResponse.json(
    {
      updatedAt: new Date().toISOString(),
      snapshotFetchedAt: data.fetchedAt ?? null,
      source: `Stooq — ICE Sugar No.11 ${near.symbol}`,
      sourceUrl: row.sourceUrl,
      symbol: near.symbol,
      contract: near,
      rollHint: rollHint(near),
      currency: 'USX',
      exchange: 'ICE',
      range,
      rangeLabel: `${near.labelEn} (${near.symbol})`,
      granularity: 'daily' as Granularity,
      intervalMinutes: '1d',
      bars: points.length,
      hasOhlc: points.some((x) => x.h != null),
      prevClose: null,
      periodOpen: points.length ? points[0].o ?? values[0] : null,
      periodHigh: values.length ? Math.max(...allNums(points.map((x) => x.h))) : null,
      periodLow: values.length ? Math.min(...allNums(points.map((x) => x.l))) : null,
      last,
      change: last != null && base != null ? last - base : null,
      changePct: last != null && base ? ((last - base) / base) * 100 : null,
      points,
      trend: fit
        ? {
            slopePerBar: fit.slope,
            r2: fit.r2,
            stdErr: fit.stdErr,
            horizonBars: horizon,
            projectedLast: projected,
            band: { lower: (projected ?? 0) - fit.stdErr, upper: (projected ?? 0) + fit.stdErr },
          }
        : null,
      stale: false,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

async function getJSON(url: string, tries = 2): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.status === 429) throw new Error('Yahoo rate limited');
      if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((res) => setTimeout(res, 350 * (i + 1)));
    }
  }
  throw lastErr;
}

function leastSquares(ys: number[]) {
  const n = ys.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxy += i * ys[i]; sxx += i * i; }
  const d = n * sxx - sx * sx;
  if (d === 0) return null;
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  const ybar = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fit = slope * i + intercept;
    ssRes += (ys[i] - fit) ** 2;
    ssTot += (ys[i] - ybar) ** 2;
  }
  return { slope, intercept, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot, stdErr: Math.sqrt(ssRes / Math.max(1, n - 2)) };
}

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const raw = (p.get('range') ?? '1d').toLowerCase();
  const from = p.get('from');
  const to = p.get('to');
  const contract = p.get('contract');

  // "near" tracks the nearest upcoming ICE delivery month straight from the
  // Stooq snapshot, re-resolving on every request so it rolls Mar -> May by itself.
  if (contract === 'near') return nearContractSeries(raw, from, to);

  let mode: Preset | 'custom' = (PRESETS as readonly string[]).includes(raw) ? (raw as Preset) : '1d';
  let interval: string;
  let granularity: Granularity;
  let query: string;
  let label: string;

  const validDate = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

  if (from && to && validDate(from) && validDate(to)) {
    const t1 = Date.parse(from);
    const t2 = Date.parse(to);
    if (t2 <= t1) {
      return NextResponse.json({ error: 'The "to" date must be after the "from" date.', range: mode, points: [] }, { status: 400 });
    }
    const days = (t2 - t1) / 86400000;
    interval = intervalForSpan(days);
    granularity = granularityFor(interval);
    const p1 = t1 - Math.min(days * 0.02 * 86400000, 6 * 3600000);
    const p2 = t2 + Math.min(days * 0.02 * 86400000, 6 * 3600000);
    query = `period1=${Math.floor(p1 / 1000)}&period2=${Math.floor(p2 / 1000)}&interval=${interval}`;
    mode = 'custom';
    label = `${from} → ${to}`;
  } else {
    const cfg = RANGE_CONFIG[mode];
    interval = cfg.interval;
    granularity = cfg.granularity;
    query = `${cfg.yahoo}&interval=${cfg.interval}`;
    label = raw;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}?${query}`;
  const key = `${mode}|${from ?? ''}|${to ?? ''}`;
  const ttl = TTL[granularity];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return NextResponse.json(hit.body);

  try {
    const payload = await getJSON(url);
    const result = (payload as any)?.chart?.result?.[0];
    if (!result) throw new Error('empty chart payload');

    const meta = result.meta ?? {};
    const q = result.indicators?.quote?.[0] ?? {};
    const stamps: number[] = Array.isArray(result.timestamp) ? result.timestamp : [];
    const closes: unknown[] = Array.isArray(q.close) ? q.close : [];

    const all: { t: number; c: number; o: number | null; h: number | null; l: number | null }[] = [];
    const rawOpen: unknown[] = Array.isArray(q.open) ? q.open : [];
    const rawHigh: unknown[] = Array.isArray(q.high) ? q.high : [];
    const rawLow: unknown[] = Array.isArray(q.low) ? q.low : [];
    for (let i = 0; i < stamps.length; i++) {
      const c = num(closes[i]);
      if (c !== null) all.push({ t: stamps[i], c, o: num(rawOpen[i]), h: num(rawHigh[i]), l: num(rawLow[i]) });
    }
    const points = all.slice(-MAX_BARS);
    const values = points.map((x) => x.c);
    if (!values.length) throw new Error('no price bars in range');

    const prevClose = granularity === 'intraday' ? num(meta.previousClose) : null;
    const highs = allNums(q.high);
    const lows = allNums(q.low);
    const opens = allNums(q.open);
    const last = num(meta.regularMarketPrice) ?? values[values.length - 1];
    const base = granularity === 'intraday' ? prevClose : values[0];
    const change = base !== null ? last - base : null;
    const changePct = base ? ((last - base) / base) * 100 : null;

    const fit = leastSquares(values);
    const horizon = HORIZON[granularity];
    const trend = fit
      ? {
          method: 'least-squares linear regression on closes',
          slopePerBar: fit.slope,
          r2: fit.r2,
          stdErr: fit.stdErr,
          horizonBars: horizon,
          projectedLast: fit.slope * (values.length - 1 + horizon) + fit.intercept,
          band: {
            lower: fit.slope * (values.length - 1 + horizon) + fit.intercept - fit.stdErr,
            upper: fit.slope * (values.length - 1 + horizon) + fit.intercept + fit.stdErr,
          },
        }
      : null;

    const body = {
      updatedAt: new Date().toISOString(),
      source: 'Yahoo Finance — ICE Sugar No.11',
      sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(SYMBOL)}/`,
      symbol: SYMBOL,
      currency: meta.currency ?? 'USX',
      exchange: meta.fullExchangeName ?? 'ICE Futures',
      range: mode,
      rangeLabel: label,
      granularity,
      intervalMinutes: interval,
      bars: points.length,
      prevClose,
      periodOpen: opens.length ? opens[0] : null,
      periodHigh: highs.length ? Math.max(...highs) : null,
      periodLow: lows.length ? Math.min(...lows) : null,
      last,
      change,
      changePct,
      points,
      trend,
      stale: false,
    };

    cache.set(key, { at: Date.now(), body });
    if (cache.size > 40) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    return NextResponse.json(body);
  } catch (e) {
    const fresh = cache.get(key);
    if (fresh && Date.now() - fresh.at < STALE_MAX) {
      return NextResponse.json({ ...(fresh.body as object), stale: true, error: e instanceof Error ? e.message : 'fetch failed' });
    }
    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      source: 'Yahoo Finance — ICE Sugar No.11',
      symbol: SYMBOL,
      range: mode,
      rangeLabel: label,
      granularity,
      bars: 0,
      points: [],
      trend: null,
      error: e instanceof Error ? e.message : 'fetch failed',
    }, { status: 200 });
  }
}