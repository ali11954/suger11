'use client';
import { useEffect, useRef, useState } from 'react';

type Contract = {
  symbol: string;
  labelAr: string;
  labelEn: string;
  monthsOut: number;
  expired: boolean;
  next?: { symbol: string; labelAr: string; labelEn: string } | null;
};
type Series = {
  updatedAt?: string;
  stale?: boolean;
  rollHint?: string;
  symbol?: string;
  contract?: Contract;
  last?: number | null;
  change?: number | null;
  changePct?: number | null;
  periodHigh?: number | null;
  periodLow?: number | null;
  prevClose?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  bars?: number;
};

type Rec = {
  net: number;
  action: string;
  actionAr: string;
  fixNow: number;
  limitPrice: number | null;
  fairValue: number | null;
  edgePct: number | null;
  confidence: number;
  confidenceAr: string;
  missing: string[];
  tranches: { pct: number; triggerAr: string }[];
  factors: { key: string; ar: string; reading: string; score: number; weight: number }[];
  caveats: string[];
};
type RecResp = { recommendation: Rec | null; cash?: { last: number; source: string } | null; next?: { symbol: string; last: number } | null };

/**
 * Headline price tile for the nearest upcoming ICE Sugar No.11 delivery month.
 * Rolls to the next month on its own once the current one is done.
 */
export default function NearContractCard() {
  const [d, setD] = useState<Series | null>(null);
  const [age, setAge] = useState<number | null>(null);
  const [rec, setRec] = useState<RecResp | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      try {
        const r = await fetch('/api/series?range=3mo&contract=near', { cache: 'no-store', signal: ctl.signal });
        const j = (await r.json()) as Series;
        if (!alive) return;
        setD(j);
        const t = j.updatedAt ? Date.parse(j.updatedAt) : NaN;
        setAge(Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null);
      } catch {
        /* keep last good value */
      }
    };
    const pullRec = async () => {
      try {
        const r = await fetch('/api/recommend', { cache: 'no-store' });
        const j = (await r.json()) as RecResp;
        if (alive) setRec(j);
      } catch {
        /* recommendation is advisory; the price tile still works without it */
      }
    };
    pull();
    pullRec();
    const id = setInterval(pull, 30_000);
    const idRec = setInterval(pullRec, 120_000);
    const tick = setInterval(() => setD((p) => p), 1000);
    return () => { alive = false; clearInterval(id); clearInterval(idRec); clearInterval(tick); abort.current?.abort(); };
  }, []);

  // Recompute the visible age each tick so it counts up live.
  useEffect(() => {
    if (!d?.updatedAt) return setAge(null);
    const t = Date.parse(d.updatedAt);
    if (!Number.isFinite(t)) return setAge(null);
    setAge(Math.max(0, Math.round((Date.now() - t) / 1000)));
  }, [d]);

  if (!d?.contract) {
    return (
      <section className="nearcard nearcard--wait" dir="rtl">
        <div className="nearcard__main">
          <span className="nearcard__label">أقرب عقد قادم</span>
          <strong className="nearcard__price">جارِ التحميل…</strong>
        </div>
      </section>
    );
  }

  const c = d.contract;
  const up = (d.change ?? 0) >= 0;
  const months = c.monthsOut;

  return (
    <section className="nearcard" dir="rtl">
      <div className="nearcard__grid">
        <div className="nearcard__left">
      <div className="nearcard__main">
        <span className="nearcard__label">
          <i className="nearcard__pulse" />
          أقرب عقد قادم · Sugar No.11
        </span>
        <div className="nearcard__price">
          {d.last != null ? d.last.toFixed(2) : '—'}
          <small>US¢/lb</small>
        </div>
        <div className="nearcard__delta">
          <b className={up ? 'up' : 'dn'}>
            {d.change != null ? `${up ? '+' : ''}${d.change.toFixed(2)}` : '—'}
            {d.changePct != null ? ` (${up ? '+' : ''}${d.changePct.toFixed(2)}%)` : ''}
          </b>
          <span className="nearcard__since">من أول الفترة</span>
        </div>
      </div>

      <div className="nearcard__meta">
        <div className="nearcard__month">
          <span className="nearcard__sym">{c.symbol}</span>
          <strong>{c.labelAr}</strong>
          <em>تسليم {months <= 0 ? 'الحالي' : `خلال ${months} ${months === 1 ? 'شهر' : 'أشهر'}`}</em>
        </div>

        <div className="nearcard__ohlc">
          <div><span>أعلى</span><b>{d.periodHigh?.toFixed(2) ?? '—'}</b></div>
          <div><span>أدنى</span><b>{d.periodLow?.toFixed(2) ?? '—'}</b></div>
          <div><span>أعمدة</span><b>{d.bars ?? '—'}</b></div>
        </div>
      </div>
        </div>

        <div className="nearcard__right">
          {rec?.recommendation ? (
            <Recommendation rec={rec.recommendation} />
          ) : (
            <div className="rec rec--hold rec--loading">
              <span className="rec__tag">مقترح الشراء والتثبيت</span>
              <strong className="rec__pending">جارِ احتساب المقترح…</strong>
            </div>
          )}
        </div>
      </div>

      <div className="nearcard__foot">
        <span className="nearcard__roll">
          {c.expired
            ? 'انتهت كل العقود المتتبعة — شغّل npm run fetch:contracts'
            : c.next
              ? `ينتقل تلقائياً إلى ${c.next.labelAr} (${c.next.symbol}) عند انتهاء ${c.labelAr}`
              : 'لا يوجد عقد تالٍ في اللقطة الحالية'}
        </span>
        <span className="nearcard__age">
          {age != null ? `آخر جلب ${age < 2 ? 'الآن' : `قبل ${age} ث`}` : '—'}
          {d.stale ? ' · بيانات مخزنة' : ''}
        </span>
      </div>
    </section>
  );
}
const TONE: Record<string, string> = {
  buy_now: 'rec--buy',
  buy_gradual: 'rec--buy',
  hold: 'rec--hold',
  wait: 'rec--wait',
  avoid: 'rec--avoid',
};

/** Purchase proposal: what to fix, at what limit, split into tranches. */
function Recommendation({ rec }: { rec: Rec }) {
  const [open, setOpen] = useState(false);
  const fix = Math.round(rec.fixNow * 100);
  const bullish = rec.net >= 20;
  const bearish = rec.net <= -20;

  return (
    <div className={`rec ${TONE[rec.action] ?? 'rec--hold'}`}>
      <div className="rec__top">
        <span className="rec__tag">
          <i className="rec__dot" />
          مقترح الشراء والتثبيت
        </span>
        <span className="rec__conf" title="جودة البيانات ووضوح الاتجاه">
          {rec.confidenceAr} · {rec.confidence}%
        </span>
      </div>

      <div className="rec__call">
        <strong>{rec.actionAr}</strong>
        <span className={`rec__score ${bullish ? 'up' : bearish ? 'dn' : ''}`}>
          {rec.net > 0 ? '+' : ''}
          {rec.net}
        </span>
      </div>

      <div className="rec__nums">
        <div>
          <span>ثبّت الآن</span>
          <b>{fix}%</b>
        </div>
        <div>
          <span>سعر الحد</span>
          <b>{rec.limitPrice != null ? rec.limitPrice.toFixed(2) : '—'}</b>
        </div>
        <div>
          <span>القيمة العادلة</span>
          <b>{rec.fairValue != null ? rec.fairValue.toFixed(2) : '—'}</b>
        </div>
        <div>
          <span>أفق القرار</span>
          <b>30 يوم</b>
        </div>
      </div>

      {rec.tranches.length > 0 && (
        <ul className="rec__tranches">
          {rec.tranches.map((t) => (
            <li key={t.triggerAr}>
              <b>{t.pct}%</b>
              <span>{t.triggerAr}</span>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="rec__toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'إخفاء الأسس' : `عرض الأسس (${rec.factors.length})`}
      </button>

      {open && (
        <div className="rec__detail">
          {rec.factors.map((f) => (
            <div key={f.key} className="rec__factor">
              <span className="rec__fname">{f.ar}</span>
              <span className="rec__fbar" aria-hidden>
                <i style={{ width: `${Math.abs(f.score) * 50}%` }} className={f.score >= 0 ? 'pos' : 'neg'} />
              </span>
              <span className="rec__fread">{f.reading}</span>
            </div>
          ))}
          {rec.missing.length > 0 && (
            <p className="rec__missing">لم تتوفر قراءة: {rec.missing.join('، ')} — حُسبت كنقص في الثقة.</p>
          )}
          <ul className="rec__caveats">
            {rec.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}