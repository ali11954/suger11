import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type Contract = {
  symbol: string;
  name: string;
  label: string;
  role: 'cash' | 'forward';
  available: boolean;
  last: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  mode: string;
  source: string;
  sourceUrl: string;
  note: string | null;
};

const CASH_SYMBOL = 'SBY00';
const FORWARD_SYMBOLS = ['SBH27', 'SBK27'];
const ALL_SYMBOLS = [CASH_SYMBOL, ...FORWARD_SYMBOLS];
const YAHOO_CASH = 'SB=F';
const BARCHART_URL = 'https://www.barchart.com/futures/quotes/SB*0/futures-prices?viewName=main';
const YAHOO_URL = `https://finance.yahoo.com/quote/${encodeURIComponent(YAHOO_CASH)}/`;

const LABEL: Record<string, string> = { SBY00: 'Cash', SBH27: 'Mar 2027', SBK27: 'May 2027', 'SB=F': 'Cash (front month)' };

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const delta = (last: number | null, base: number | null) =>
  last === null || base === null || base === 0 ? null : ((last - base) / base) * 100;

const firstNum = (arr: unknown): number | null => {
  if (!Array.isArray(arr)) return null;
  for (const v of arr) { const x = num(v); if (x !== null) return x; }
  return null;
};

const allNums = (arr: unknown): number[] =>
  Array.isArray(arr) ? arr.map(num).filter((v): v is number => v !== null) : [];

function unavailable(symbol: string, role: Contract['role'], source: string, sourceUrl: string, note: string): Contract {
  return {
    symbol,
    name: LABEL[symbol] ?? symbol,
    label: LABEL[symbol] ?? symbol,
    role,
    available: false,
    last: null, open: null, high: null, low: null, prevClose: null,
    change: null, changePct: null,
    mode: 'unavailable',
    source, sourceUrl, note,
  };
}

async function barchart(symbols: string[]) {
  const key = process.env.BARCHART_API_KEY;
  if (!key) return null;
  const url = `https://ondemand.websol.barchart.com/getQuote.json?apikey=${encodeURIComponent(key)}&symbols=${encodeURIComponent(symbols.join(','))}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Barchart HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.results) ? j.results : [];
}

function fromBarchart(x: any, role: Contract['role']): Contract {
  const symbol = String(x?.symbol ?? '');
  const last = num(x?.lastPrice);
  const prevClose = num(x?.previousClose);
  const netChange = num(x?.netChange);
  const change = netChange ?? (last !== null && prevClose !== null ? last - prevClose : null);
  return {
    symbol,
    name: String(x?.name ?? '').replace('Sugar #11 ', '') || LABEL[symbol] || symbol,
    label: LABEL[symbol] || symbol,
    role,
    available: last !== null,
    last,
    open: num(x?.open),
    high: num(x?.high),
    low: num(x?.low),
    prevClose,
    change,
    changePct: num(x?.percentChange) ?? delta(last, prevClose),
    mode: String(x?.mode ?? 'delayed').toLowerCase(),
    source: 'Barchart OnDemand — ICE Sugar No.11',
    sourceUrl: BARCHART_URL,
    note: null,
  };
}

const SNAPSHOT_FILE = path.join(process.cwd(), 'data', 'contracts.json');
const SNAPSHOT_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

type SnapshotContract = {
  symbol: string;
  label: string;
  available?: boolean;
  last?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null;
  change?: number | null;
  changePct?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  tradeDate?: string | null;
  source?: string;
  sourceUrl?: string;
};

type Snapshot = {
  at: number;
  fetchedAt: string;
  by: Map<string, SnapshotContract>;
};

let snapshotCache: Snapshot | null = null;

async function stooqSnapshot(): Promise<Snapshot | null> {
  if (snapshotCache && Date.now() - snapshotCache.at < 30_000) return snapshotCache;
  try {
    const parsed = JSON.parse(await fs.readFile(SNAPSHOT_FILE, 'utf8'));
    const list: SnapshotContract[] = Array.isArray(parsed?.contracts) ? parsed.contracts : [];
    if (!list.length) return null;
    snapshotCache = {
      at: Date.now(),
      fetchedAt: String(parsed?.fetchedAt ?? ''),
      by: new Map(list.map((c) => [String(c.symbol ?? '').toUpperCase(), c])),
    };
    return snapshotCache;
  } catch {
    return null;
  }
}

function fromSnapshot(c: SnapshotContract, role: Contract['role'], fetchedAt: string): Contract {
  const label = c.label || c.symbol;
  const age = fetchedAt ? Date.now() - Date.parse(fetchedAt) : Number.NaN;
  const stale = Number.isFinite(age) && age > SNAPSHOT_MAX_AGE_MS;
  const last = num(c.last);
  return {
    symbol: c.symbol,
    name: label,
    label,
    role,
    available: last !== null,
    last,
    open: num(c.open),
    high: num(c.high),
    low: num(c.low),
    prevClose: num(c.prevClose),
    change: num(c.change),
    changePct: num(c.changePct),
    mode: 'delayed',
    source: c.source ?? 'Stooq — ICE Sugar No.11',
    sourceUrl: c.sourceUrl ?? 'https://stooq.com/q/d/',
    note: stale ? `Snapshot older than 5 days (${fetchedAt.slice(0, 10)}). Re-run: npm run fetch:contracts` : null,
  };
}

async function yahooCash(): Promise<{ contract: Contract | null; series: number[] }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_CASH)}?range=1d&interval=5m`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const result = (await r.json())?.chart?.result?.[0];
  if (!result) return { contract: null, series: [] };
  const meta = result.meta ?? {};
  const q = result.indicators?.quote?.[0] ?? {};
  const closes = (q.close ?? []).filter((v: unknown): v is number => num(v) !== null) as number[];
  const last = num(meta.regularMarketPrice) ?? closes[closes.length - 1] ?? null;
  const prevClose = num(meta.previousClose);
  if (last === null) return { contract: null, series: closes };
  const highs = allNums(q.high);
  const lows = allNums(q.low);
  return {
    series: closes,
    contract: {
      symbol: YAHOO_CASH,
      name: String(meta.shortName ?? 'Sugar No.11').replace('Sugar #11 ', '') || 'Cash (front month)',
      label: LABEL[YAHOO_CASH],
      role: 'cash',
      available: true,
      last,
      open: firstNum(q.open) ?? highs[0] ?? null,
      high: highs.length ? Math.max(...highs) : null,
      low: lows.length ? Math.min(...lows) : null,
      prevClose,
      change: last !== null && prevClose !== null ? last - prevClose : null,
      changePct: delta(last, prevClose),
      mode: 'delayed',
      source: 'Yahoo Finance — ICE Sugar No.11 front month',
      sourceUrl: YAHOO_URL,
      note: null,
    },
  };
}

export async function GET() {
  const now = new Date().toISOString();
  const key = process.env.BARCHART_API_KEY;
  const providers = { barchart: Boolean(key), stooq: false, yahoo: false };

  const by = new Map<string, Contract>();
  let barchartError: string | null = null;

  // 1) Barchart OnDemand (authoritative, needs key)
  if (key) {
    try {
      const rows = await barchart(ALL_SYMBOLS);
      for (const x of (rows ?? []) as any[]) {
        const s = String(x?.symbol ?? '').toUpperCase();
        if (ALL_SYMBOLS.includes(s)) by.set(s, fromBarchart(x, s === CASH_SYMBOL ? 'cash' : 'forward'));
      }
    } catch (e) {
      barchartError = e instanceof Error ? e.message : 'Barchart request failed';
    }
  }

  // 2) Yahoo front month — authoritative and live for the cash contract.
  //    (Stooq's sb.f composite is deliberately not used for cash: it has rolled
  //    to Mar-2027 and would silently duplicate the Mar card.)
  if (!by.get(CASH_SYMBOL)?.available) {
    try {
      const { contract } = await yahooCash();
      if (contract) {
        providers.yahoo = true;
        by.set(CASH_SYMBOL, contract);
      }
    } catch {
      /* cash falls through to the snapshot */
    }
  }

  // 3) Stooq snapshot for the individual ICE forwards (Mar / May 2027)
  const snapshot = await stooqSnapshot();
  for (const s of ALL_SYMBOLS) {
    if (by.get(s)?.available) continue;
    const sc = snapshot?.by.get(s);
    if (sc && num(sc.last) !== null) {
      by.set(s, fromSnapshot(sc, s === CASH_SYMBOL ? 'cash' : 'forward', snapshot?.fetchedAt ?? ''));
      providers.stooq = true;
    }
  }

  const fallbackNote = key
    ? `Barchart key present but quote missing (${barchartError ?? 'no result'}).`
    : 'Run `npm run fetch:contracts` to refresh the Stooq snapshot.';

  const contracts = ALL_SYMBOLS.map((s) => {
    const c = by.get(s);
    if (c?.available) return c;
    return unavailable(s, s === CASH_SYMBOL ? 'cash' : 'forward', 'none', BARCHART_URL, fallbackNote);
  });

  const spreads = contracts.length >= 3
    ? [1, 2].flatMap((i) => {
        const prev = contracts[i - 1].last;
        const cur = contracts[i].last;
        if (prev === null || cur === null) return [];
        return [{
          from: contracts[i - 1].label,
          to: contracts[i].label,
          value: cur - prev,
          pct: delta(cur, prev),
        }];
      })
    : [];

  const priced = contracts.filter((c) => c.available).length;
  const active = [
    contracts.some((c) => c.source.includes('Barchart')) ? 'Barchart OnDemand' : null,
    providers.stooq ? 'Stooq snapshot' : null,
    providers.yahoo ? 'Yahoo Finance' : null,
  ].filter(Boolean) as string[];

  return NextResponse.json({
    updatedAt: now,
    source: active.length ? active.join(' + ') : 'No live feed',
    mode: contracts[0]?.mode ?? 'unavailable',
    providers,
    note: barchartError,
    snapshotFetchedAt: snapshot?.fetchedAt ?? null,
    contracts,
    spreads,
    coverage: { total: contracts.length, priced },
  });
}