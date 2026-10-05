'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

type Point = { t: number; c: number; o?: number | null; h?: number | null; l?: number | null };
type ChartType = 'area' | 'line' | 'candles' | 'bars';
type Trend = {
  method: string;
  slopePerBar: number;
  r2: number;
  stdErr: number;
  horizonBars: number;
  projectedLast: number;
  band: { lower: number; upper: number };
};
type Granularity = 'intraday' | 'hourly' | 'daily';
type Series = {
  updatedAt?: string;
  stale?: boolean;
  rollHint?: string;
  symbol?: string;
  contract?: { symbol: string; labelAr: string; labelEn: string; monthsOut: number; expired: boolean; next?: { symbol: string; labelEn: string } | null };
  source?: string;
  sourceUrl?: string;
  currency?: string;
  exchange?: string;
  range?: string;
  rangeLabel?: string;
  granularity?: Granularity;
  intervalMinutes?: string;
  bars?: number;
  prevClose?: number | null;
  periodOpen?: number | null;
  periodHigh?: number | null;
  periodLow?: number | null;
  last?: number | null;
  change?: number | null;
  changePct?: number | null;
  points?: Point[];
  trend?: Trend | null;
  error?: string;
};

const REFRESH_MS = 30000;
const W = 760;
const H = 240;
const PAD = { top: 16, right: 54, bottom: 26, left: 10 };

const PERIODS: { key: string; label: string; ar: string }[] = [
  { key: '1d', label: 'Day', ar: 'اليوم' },
  { key: '5d', label: 'Week', ar: 'الأسبوع' },
  { key: '1mo', label: 'Month', ar: 'الشهر' },
  { key: '3mo', label: '3 Months', ar: '3 أشهر' },
  { key: '1y', label: 'Year', ar: 'السنة' },
  { key: '5y', label: '5 Years', ar: '5 سنوات' },
];

const CHART_TYPES: { key: ChartType; label: string }[] = [
  { key: 'area', label: 'Area' },
  { key: 'line', label: 'Line' },
  { key: 'candles', label: 'Candles' },
  { key: 'bars', label: 'Bars' },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toFixed(d));

export default function CashChart() {
  const [data, setData] = useState<Series | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [period, setPeriod] = useState('1d');
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 90 * 86400000)));
  const [to, setTo] = useState(() => iso(new Date()));
  const [showCal, setShowCal] = useState(false);
  const [chartType, setChartType] = useState<ChartType>('area');
  const [feed, setFeed] = useState<'near' | 'front'>('near');
  const [pending, setPending] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/:/g, '');
  const abort = useRef<AbortController | null>(null);

  // Ticks every second so the panel visibly proves it is refreshing on its own.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const fetchedMs = data?.updatedAt ? Date.parse(data.updatedAt) : NaN;
  const fetchedOk = Number.isFinite(fetchedMs);
  const ageSec = fetchedOk ? Math.max(0, Math.round((now - fetchedMs) / 1000)) : null;
  const hhmm = fetchedOk
    ? new Date(fetchedMs).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      try {
        const span = period === 'custom' ? `range=custom&from=${from}&to=${to}` : `range=${period}`;
        // "near" = nearest upcoming ICE delivery month (auto-rolls). "front" = Yahoo continuous SB=F.
        const qs = feed === 'near' ? `${span}&contract=near` : span;
        setPending(true);
        const r = await fetch(`/api/series?${qs}`, { cache: 'no-store', signal: ctl.signal });
        const j = (await r.json()) as Series;
        if (!alive) return;
        setData(j);
        setErr(j.error ?? null);
      } catch (e) {
        if (alive && (e as Error)?.name !== 'AbortError') setErr((e as Error).message);
      } finally {
        if (alive) setPending(false);
      }
    };
    pull();
    const id = setInterval(pull, REFRESH_MS);
    return () => { alive = false; clearInterval(id); abort.current?.abort(); };
  }, [period, from, to, feed]);

  const gran: Granularity = data?.granularity ?? 'intraday';

  const g = useMemo(() => {
    const pts = data?.points ?? [];
    const prevClose = data?.prevClose ?? null;
    const trend = data?.trend ?? null;
    const horizon = trend?.horizonBars ?? 0;
    if (!pts.length) return null;

    const vals = pts.map((p) => p.c);
    for (const p of pts) {
      if (p.h != null) vals.push(p.h);
      if (p.l != null) vals.push(p.l);
    }
    if (prevClose != null) vals.push(prevClose);
    if (trend) vals.push(trend.band.lower, trend.band.upper);

    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi === lo) { hi += 0.05; lo -= 0.05; }
    const padY = (hi - lo) * 0.12;
    lo -= padY; hi += padY;

    const n = pts.length;
    const total = n - 1 + horizon;
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;

    const X = (i: number) => PAD.left + (total === 0 ? 0 : (i / total) * iw);
    const Y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * ih;

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(2)},${Y(p.c).toFixed(2)}`).join('');
    const area = `${line}L${X(n - 1).toFixed(2)},${(PAD.top + ih).toFixed(2)}L${X(0).toFixed(2)},${(PAD.top + ih).toFixed(2)}Z`;

    const lastIdx = n - 1;
    let proj = '';
    let bandTop = '';
    let bandBot = '';
    if (trend && horizon > 0) {
      const startY = Y(pts[lastIdx].c);
      proj = `M${X(lastIdx).toFixed(2)},${startY.toFixed(2)}` +
        Array.from({ length: horizon }, (_, k) => {
          const i = lastIdx + k + 1;
          return `L${X(i).toFixed(2)},${(startY + (Y(trend.projectedLast) - startY) * ((k + 1) / horizon)).toFixed(2)}`;
        }).join('');
      {
        const top: string[] = [];
        const bot: string[] = [];
        for (let k = 0; k <= horizon; k++) {
          const i = lastIdx + k;
          const f = k / horizon;
          const x = X(i).toFixed(2);
          top.push(`${x},${(startY + (Y(trend.band.upper) - startY) * f).toFixed(2)}`);
          bot.unshift(`${x},${(startY + (Y(trend.band.lower) - startY) * f).toFixed(2)}`);
        }
        bandTop = top.join('L'); bandBot = bot.join('L');
      }
    }

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: lo + (hi - lo) * (1 - f), y: PAD.top + f * ih }));

    // Candle / bar geometry, plus hover mapping from SVG x back to a bar index.
    const hasOhlc = pts.some((p) => p.h != null && p.l != null);
    const slot = total > 0 ? iw / total : iw;
    const bodyW = Math.max(1, Math.min(9, slot * 0.62));
    const candles = pts.map((p, i) => {
      const prev = i > 0 ? pts[i - 1].c : (prevClose ?? p.c);
      const o = p.o ?? prev;
      const h = p.h ?? Math.max(o, p.c);
      const l = p.l ?? Math.min(o, p.c);
      const up = p.c >= prev;
      return { i, o, h, l, c: p.c, up, x: X(i), yO: Y(o), yH: Y(h), yL: Y(l), yC: Y(p.c) };
    });
    const idxAt = (vx: number) =>
      Math.max(0, Math.min(n - 1, Math.round(((vx - PAD.left) / (iw || 1)) * total)));
    const spanDays = (pts[n - 1].t - pts[0].t) / 86400;
    const label = (i: number) => {
      const d = new Date(pts[Math.min(i, n - 1)].t * 1000);
      if (gran === 'intraday') return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      if (gran === 'hourly') return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit' });
      return spanDays > 400
        ? d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
        : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    };

    return { X, Y, line, area, proj, bandPath: bandTop && bandBot ? `M${bandTop}L${bandBot}Z` : '', lastIdx, ticks, label, lo, hi, prevY: prevClose != null ? Y(prevClose) : null, lastY: Y(pts[lastIdx].c), lastX: X(lastIdx), n, pts, total, ih, bodyW, candles, hasOhlc, idxAt, baseY: PAD.top + ih };
  }, [data, gran]);

  const positive = (data?.change ?? 0) >= 0;
  const stroke = positive ? '#5bd48a' : '#f2777a';
  const head = PERIODS.find((p) => p.key === period);
  const granWord = gran === 'intraday' ? `${data?.intervalMinutes ?? '5m'} min bars` : gran === 'hourly' ? 'hourly bars' : 'daily bars';
  const rangeWord = period === 'custom' ? (data?.rangeLabel ?? `${from} → ${to}`) : (head?.label ?? period);
  const baseWord = gran === 'intraday' ? 'Prev close' : 'Period open';

  return (
    <section className="card chart" dir="ltr">
      <div className="cardhead">
        <div>
          <span className="kicker">{rangeWord.toUpperCase()} · {granWord.toUpperCase()}</span>
          <h2>
            {feed === 'near' && data?.contract
              ? `Sugar #11 — ${data.contract.symbol} · ${data.contract.labelEn}`
              : `Cash Sugar #11 — ${period === 'custom' ? 'custom range' : 'price indicator'}`}
          </h2>
          {feed === 'near' && data?.rollHint && <p className="chart__roll">{data.rollHint}</p>}
        </div>
        <div className="chart__meta">
          <span className={positive ? 'online' : 'offline'}>{data?.bars ? `${data.bars} bars` : 'no data'}</span>
          <span className="chart__refresh" title="وقت جلب البيانات من المصدر (يتحدث تلقائياً)">
            <i className="chart__tick" />
            <span>
              {!fetchedOk ? 'جارِ التحميل…' : `آخر جلب ${hhmm}${ageSec != null ? ` · قبل ${ageSec} ث` : ''}`}
              {pending && ' ⟳'}
            </span>
          </span>
          {data?.stale && <span className="chart__stale">بيانات مخزنة مؤقتاً — إعادة المحاولة جارية</span>}
        </div>
      </div>

      <div className="periods">
        <button type="button" className={feed === 'near' ? 'on' : ''} onClick={() => setFeed('near')} title="أقرب عقد قادم — ينتقل تلقائياً عند الانتهاء">
          أقرب عقد
        </button>
        <button type="button" className={feed === 'front' ? 'on' : ''} onClick={() => setFeed('front')} title="العقد المستمر من Yahoo">
          مستمر
        </button>
        <span className="periods__sep" />
        {PERIODS.map((p) => (
          <button key={p.key} type="button" className={period === p.key ? 'on' : ''} onClick={() => setPeriod(p.key)}>
            {p.label}
          </button>
        ))}
        <button type="button" className={period === 'custom' ? 'on' : ''} onClick={() => setPeriod('custom')}>
          From — To
        </button>
      </div>

      <div className="charttypes" role="group" aria-label="Chart type">
        {CHART_TYPES.map((ct) => (
          <button
            key={ct.key}
            type="button"
            className={chartType === ct.key ? 'on' : ''}
            disabled={g ? (ct.key === 'candles' && !g.hasOhlc) : false}
            title={ct.key === 'candles' && g && !g.hasOhlc ? 'No OHLC data for this range' : undefined}
            onClick={() => setChartType(ct.key)}
          >
            {ct.label}
          </button>
        ))}
      </div>

      {period === 'custom' && (
        <div className="cal">
          <label>From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} min={from} max={iso(new Date())} onChange={(e) => setTo(e.target.value)} /></label>
          <span className="calhint">
            {new Date(from) < new Date(to)
              ? `${Math.round((Date.parse(to) - Date.parse(from)) / 86400000)} days selected`
              : 'The “to” date must be after the “from” date'}
          </span>
        </div>
      )}

      {g ? (
        <>
          <div className="chartstats">
            <div><span>Last</span><b style={{ color: stroke }}>{fmt(data?.last)}</b></div>
            <div><span>Change</span><b style={{ color: stroke }}>{data?.change != null && data.change > 0 ? '+' : ''}{fmt(data?.change)} ({fmt(data?.changePct)}%)</b></div>
            <div><span>{baseWord}</span><b>{fmt(gran === 'intraday' ? data?.prevClose : data?.periodOpen)}</b></div>
            <div><span>{gran === 'intraday' ? 'Day range' : 'Range low — high'}</span><b>{fmt(data?.periodLow)} — {fmt(data?.periodHigh)}</b></div>
          </div>

          <svg
            className="spark"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Cash sugar price, ${rangeWord}`}
            onMouseMove={(e) => {
              if (!g) return;
              const r = e.currentTarget.getBoundingClientRect();
              if (!r.width) return;
              setHover(g.idxAt(((e.clientX - r.left) / r.width) * W));
            }}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={`fill${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
                <stop offset="100%" stopColor={stroke} stopOpacity="0" />
              </linearGradient>
            </defs>

            {g.ticks.map((t, i) => (
              <g key={i}>
                <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} stroke="#17304a" strokeWidth="1" />
                <text x={W - PAD.right + 6} y={t.y + 4} className="axlbl">{t.v.toFixed(2)}</text>
              </g>
            ))}

            {g.prevY != null && (
              <g>
                <line x1={PAD.left} x2={W - PAD.right} y1={g.prevY} y2={g.prevY} stroke="#6b8aa3" strokeWidth="1" strokeDasharray="4 4" />
                <text x={PAD.left + 4} y={g.prevY - 5} className="axlbl">prev {fmt(data?.prevClose)}</text>
              </g>
            )}

            {g.bandPath && chartType !== 'candles' && chartType !== 'bars' && <path d={g.bandPath} fill="#8fb6d6" fillOpacity="0.13" stroke="none" />}
            {g.proj && chartType !== 'candles' && chartType !== 'bars' && <path d={g.proj} fill="none" stroke="#8fb6d6" strokeWidth="1.6" strokeDasharray="5 4" />}

            {chartType === 'area' && <path d={g.area} fill={`url(#fill${uid})`} />}
            {chartType === 'line' && <path d={g.line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}

            {chartType === 'candles' && g.hasOhlc && (
              <g>
                {g.candles.map((k) => (
                  <g key={k.i} opacity={hover == null || hover === k.i ? 1 : 0.45}>
                    <line x1={k.x.toFixed(2)} x2={k.x.toFixed(2)} y1={k.yH.toFixed(2)} y2={k.yL.toFixed(2)} stroke={k.up ? '#5bd48a' : '#f2777a'} strokeWidth="1" />
                    <rect
                      x={(k.x - g.bodyW / 2).toFixed(2)}
                      width={g.bodyW.toFixed(2)}
                      y={Math.min(k.yO, k.yC).toFixed(2)}
                      height={Math.max(1, Math.abs(k.yO - k.yC)).toFixed(2)}
                      fill={k.up ? '#5bd48a' : '#f2777a'}
                    />
                  </g>
                ))}
              </g>
            )}

            {chartType === 'bars' && (
              <g>
                {g.candles.map((k) => (
                  <rect
                    key={k.i}
                    x={(k.x - g.bodyW / 2).toFixed(2)}
                    width={g.bodyW.toFixed(2)}
                    y={Math.min(k.yC, g.baseY).toFixed(2)}
                    height={Math.max(1, Math.abs(k.yC - g.baseY)).toFixed(2)}
                    fill={k.up ? '#5bd48a' : '#f2777a'}
                    opacity={hover == null || hover === k.i ? 0.92 : 0.4}
                  />
                ))}
              </g>
            )}

            {(chartType === 'area' || chartType === 'line') && (
              <>
                <circle cx={g.lastX} cy={g.lastY} r="8" fill={stroke} opacity="0.18">
                  <animate attributeName="r" values="5;11;5" dur="2.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.3;0;0.3" dur="2.2s" repeatCount="indefinite" />
                </circle>
                <circle cx={g.lastX} cy={g.lastY} r="3.6" fill={stroke} />
              </>
            )}

            {hover != null && g.pts[hover] && (() => {
              const p = g.pts[hover];
              const k = g.candles[hover];
              const hx = g.X(hover);
              const hy = g.Y(p.c);
              const flip = hx > W - PAD.right - 150;
              const bx = flip ? hx - 152 : hx + 10;
              const by = Math.max(PAD.top + 2, Math.min(hy - 44, H - PAD.bottom - 62));
              const rows: [string, string][] = [
                ['Close', p.c.toFixed(2)],
                ...(k && k.h != null && p.h != null ? ([['High', p.h.toFixed(2)]] as [string, string][]) : []),
                ...(p.l != null ? ([['Low', p.l.toFixed(2)]] as [string, string][]) : []),
              ];
              return (
                <g pointerEvents="none">
                  <line x1={hx.toFixed(2)} x2={hx.toFixed(2)} y1={PAD.top} y2={H - PAD.bottom} stroke="#8fb6d6" strokeWidth="1" strokeDasharray="3 3" />
                  <line x1={PAD.left} x2={W - PAD.right} y1={hy.toFixed(2)} y2={hy.toFixed(2)} stroke="#8fb6d6" strokeWidth="1" strokeDasharray="3 3" />
                  <circle cx={hx.toFixed(2)} cy={hy.toFixed(2)} r="4" fill="#fff" stroke={stroke} strokeWidth="2" />
                  <rect x={bx.toFixed(2)} y={by.toFixed(2)} width="142" height={20 + rows.length * 13} rx="7" fill="#0b1926" stroke="#2b4d68" />
                  <text x={(bx + 8).toFixed(2)} y={(by + 14).toFixed(2)} className="axlbl">
                    {new Date(p.t * 1000).toLocaleString('en-GB', gran === 'intraday' ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', year: '2-digit' })}
                  </text>
                  {rows.map((r, ri) => (
                    <text key={r[0]} x={(bx + 8).toFixed(2)} y={(by + 28 + ri * 13).toFixed(2)} className="axlbl">
                      {r[0]} {r[1]}
                    </text>
                  ))}
                </g>
              );
            })()}

            <text x={PAD.left} y={H - 8} className="axlbl">{g.label(0)}</text>
            <text x={(g.X(g.lastIdx) / 2 + PAD.left / 2).toFixed(0)} y={H - 8} className="axlbl mid">{g.label(Math.floor(g.lastIdx / 2))}</text>
            <text x={g.lastX} y={H - 8} className="axlbl end">{g.label(g.lastIdx)}</text>
          </svg>

          <div className="chartfoot">
            {data?.trend
              ? <>
                  <span className="lg"><i className="dash" /> Projection — {data.trend.method}, {data.trend.horizonBars} bars ahead, R²={data.trend.r2.toFixed(2)}</span>
                  <span className="lg">Target {fmt(data.trend.projectedLast)} (1σ {fmt(data.trend.band.lower)} — {fmt(data.trend.band.upper)})</span>
                </>
              : <span className="lg">Not enough bars to fit a trend</span>}
            <span className="lg">Auto-refresh {REFRESH_MS / 1000}s · {data?.source}</span>
          </div>
        </>
      ) : (
        <div className="chartempty">
          <b>{err ? 'Feed unavailable' : 'Loading feed…'}</b>
          <span>{err ?? `Fetching ICE Sugar No.11 — ${rangeWord}`}</span>
          {data?.sourceUrl && <a href={data.sourceUrl} target="_blank" rel="noreferrer noopener">Open source ↗</a>}
        </div>
      )}
    </section>
  );
}