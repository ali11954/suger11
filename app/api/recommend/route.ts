import { NextResponse } from 'next/server';
import { buildRecommendation, linreg, type Inputs } from '../../../lib/recommend';
import { resolveNear } from '../../../lib/iceCalendar';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

async function readJson(rel: string): Promise<any | null> {
  try {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    return JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', rel), 'utf8'));
  } catch {
    return null;
  }
}

/** Yahoo chart API with a hard timeout; one dropped leg must not skew the score. */
async function yahoo<T>(symbol: string, range = '5d'): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const host = attempt % 2 === 0 ? 'query1' : 'query2';
    // Without this the route hung for 38s when Yahoo stalled; a dead upstream
    // should degrade to a missing factor, not block the whole card.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`, {
        cache: 'no-store',
        signal: ctl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      /* retry on the alternate host */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function macroPct(symbol: string): Promise<number | null> {
  try {
    const j = await yahoo<any>(symbol);
    const res = j?.chart?.result?.[0];
    const closes: number[] = (res?.indicators?.quote?.[0]?.close ?? []).filter((v: unknown): v is number => typeof v === 'number');
    const last = typeof res?.meta?.regularMarketPrice === 'number' ? res.meta.regularMarketPrice : closes[closes.length - 1];
    const prev = closes.length >= 2 ? closes[closes.length - 2] : null;
    if (last == null || !prev) return null;
    return ((last - prev) / prev) * 100;
  } catch {
    return null;
  }
}

/** Yahoo front-month continuous: the only genuine cash leg for Sugar No.11. */
async function cashQuote(): Promise<{ last: number; previousClose: number | null; at: string | null } | null> {
  const res = (await yahoo<Record<string, any>>('SB=F'))?.chart?.result?.[0];
  const last = res?.meta?.regularMarketPrice;
  if (typeof last !== 'number') return null;
  const closes: number[] = (res?.indicators?.quote?.[0]?.close ?? []).filter((v: unknown): v is number => typeof v === 'number');
  const previousClose = typeof res?.meta?.chartPreviousClose === 'number' ? res.meta.chartPreviousClose : closes[closes.length - 2] ?? null;
  return {
    last,
    previousClose,
    at: typeof res?.meta?.regularMarketTime === 'number' ? new Date(res.meta.regularMarketTime * 1000).toISOString() : null,
  };
}

const TTL_MS = 3 * 60 * 1000;
let cached: { at: number; body: unknown } | null = null;

/**
 * Purchase decision support.
 *
 * Reads the same snapshot that prices the dashboard cards, so the call can never
 * contradict the numbers on screen. Deliberately avoids calling our own API
 * routes: a self-fetch would recurse through the cold-start caches.
 */
export async function GET() {
  // Yahoo degrades to 6s timeouts, so without this the top card would sit on
  // "جارِ احتساب المقترح" for 10s+ on every visit.
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json(cached.body, { headers: { 'Cache-Control': 'no-store', 'X-Rec-Cache': 'hit' } });
  }
  const body = await compute();
  cached = { at: Date.now(), body };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store', 'X-Rec-Cache': 'miss' } });
}

async function compute() {
  const snap = await readJson('contracts.json');
  const feed = await readJson('drivers-cache.json');

  const rows: any[] = snap?.contracts ?? [];
  const priced = rows.filter((c) => c.role !== 'cash' && c.available && Array.isArray(c.history) && c.history.length);
  const nearRef = resolveNear(priced.map((c) => c.symbol));
  const nearRow = priced.find((c) => c.symbol === nearRef?.symbol) ?? null;
  // Cash leg must come from Yahoo SB=F. Stooq's sb.f row is a duplicate of the
  // near contract (it reported 19.93 for both), which flattens the curve to 0%.
  const [brlPct, brentPct, dxyPct, cashYahoo] = await Promise.all([
    macroPct('BRLUSD=X'),
    macroPct('BZ=F'),
    macroPct('DX-Y.NYB'),
    cashQuote(),
  ]);

  const near = nearRow?.last ?? null;
  const cash = cashYahoo?.last ?? null;
  const cashMeta = cashYahoo ? { ...cashYahoo, source: 'Yahoo SB=F (continuous)' } : null;
  const nextRow = priced
    .filter((c) => c.symbol !== nearRow?.symbol)
    .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)))[0];

  const closes: number[] = (nearRow?.history ?? []).map((p: any) => p.c).filter((v: unknown): v is number => typeof v === 'number');
  const fit = linreg(closes);

  const weather = feed?.weather ?? [];
  const brazil = weather.find((w: any) => w.key === 'brazil');
  const news: any[] = feed?.news ?? [];
  const HAZARD = new Set(['weather', 'quake', 'geopolitics', 'shipping']);

  const pct = (a: number | null, b: number | null | undefined) => (a != null && b ? ((a - b) / b) * 100 : null);

  const inputs: Inputs = {
    last: near,
    slopePerBar: fit?.slope ?? null,
    r2: fit?.r2 ?? null,
    bars: closes.length,
    cashCurvePct: pct(cash, near),
    rollCurvePct: pct(near, nextRow?.last ?? null),
    brlPct,
    brentPct,
    dxyPct,
    brazilRain: brazil?.rainDay ?? null,
    hazardNews: news.filter((n) => HAZARD.has(n.topic)).length,
    sugarNews: news.filter((n) => !HAZARD.has(n.topic) && n.topic !== 'general').length,
    snapshotAgeH: snap?.fetchedAt ? Math.max(0, Math.round((Date.now() - Date.parse(snap.fetchedAt)) / 3.6e6)) : null,
    macroOk: [brlPct, brentPct, dxyPct].filter((v) => v != null).length,
    macroTotal: 3,
  };

  return {
    contract: nearRef,
    cash: cashMeta,
    next: nextRow ? { symbol: nextRow.symbol, label: nextRow.label, last: nextRow.last } : null,
    bars: closes.length,
    regression: fit ? { slope: fit.slope, r2: Math.round(fit.r2 * 1000) / 1000, stdErr: fit.stdErr } : null,
    inputs,
    source: {
      snapshotFetchedAt: snap?.fetchedAt ?? null,
      newsFetchedAt: feed?.at ? new Date(feed.at).toISOString() : null,
      prices: 'Stooq snapshot (data/contracts.json)',
    },
    recommendation: buildRecommendation(inputs),
  };
}