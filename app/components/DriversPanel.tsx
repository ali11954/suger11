'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NewsTicker, { type TickerItem } from './NewsTicker';
import { UPLOAD_ENABLED } from '../../lib/featureFlags';

type Macro = {
  symbol: string;
  key: string;
  ar: string;
  en: string;
  impact: 'high' | 'medium';
  whyAr: string;
  whyEn: string;
  last: number | null;
  change: number | null;
  changePct: number | null;
  ok: boolean;
};

type News = {
  title: string;
  link: string;
  source: string;
  publishedAt: string | null;
  topic: string;
  topicAr: string;
  topicEn: string;
  matched: string[];
};

type UploadedItem = {
  id: string;
  file: string;
  topic: string;
  topicAr: string;
  topicEn: string;
  text: string;
  relevance: number;
  at?: string;
};

type Weather = {
  key: string;
  ar: string;
  en: string;
  temp: number | null;
  rainNow: number | null;
  rainDay: number | null;
  wind: number | null;
  tmax: number | null;
  ok: boolean;
};

type Tab = 'drivers' | 'news' | 'files' | 'weather';

const TOPIC_ORDER = ['weather', 'quake', 'geopolitics', 'shipping', 'brazil', 'india', 'thailand', 'energy', 'stocks', 'market', 'currency', 'policy', 'general'];

export default function DriversPanel() {
  const [macro, setMacro] = useState<Macro[]>([]);
  const [news, setNews] = useState<News[]>([]);
  const [uploaded, setUploaded] = useState<UploadedItem[]>([]);
  const [weather, setWeather] = useState<Weather[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('drivers');
  const [busy, setBusy] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/drivers');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setMacro(j.macro ?? []);
      setNews(j.news ?? []);
      setUploaded(j.uploads?.items ?? []);
      setWeather(j.weather ?? []);
      setUpdatedAt(j.updatedAt ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [load]);

  async function send(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setUploadMsg(null);
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const j = await r.json();
      const total = (j.results ?? []).reduce((n: number, x: { driversFound?: number }) => n + (x.driversFound ?? 0), 0);
      const bad = (j.results ?? []).filter((x: { error?: string }) => x.error);
      setUploadMsg({
        ok: !bad.length && total > 0,
        text: bad.length
          ? `${total} عامل مستخرج — ${bad.length} ملف فشل`
          : `تم استخراج ${total} عامل من ${(j.results ?? []).length} ملف`,
      });
      await load();
    } catch {
      setUploadMsg({ ok: false, text: 'فشل الاتصال بالخادم' });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const tickerItems = useMemo<TickerItem[]>(() => {
    const HAZARD = new Set(['weather', 'quake', 'geopolitics', 'shipping']);
    // Hazard headlines lead the ticker, then market, then everything else.
    const ranked = [...news].sort((a, b) => {
      const r = (n: News) => (HAZARD.has(n.topic) ? 0 : n.topic === 'general' ? 2 : 1);
      return r(a) - r(b);
    });
    const fromNews: TickerItem[] = ranked.slice(0, 20).map((n, i) => ({
      id: `n${i}`,
      text: n.title,
      topic: n.topicEn,
      topicAr: n.topicAr,
      source: n.source,
      href: n.link,
      origin: 'live',
    }));
    const fromFiles: TickerItem[] = uploaded.slice(0, 10).map((u) => ({
      id: u.id,
      text: u.text,
      topic: u.topicEn,
      topicAr: u.topicAr,
      source: u.file,
      origin: 'upload',
    }));
    return [...fromNews, ...fromFiles];
  }, [news, uploaded]);

  const byTopic = useMemo(() => {
    const m = new Map<string, News[]>();
    for (const n of news) {
      const arr = m.get(n.topic) ?? [];
      arr.push(n);
      m.set(n.topic, arr);
    }
    return [...m.entries()].sort(
      (a, b) => TOPIC_ORDER.indexOf(a[0]) - TOPIC_ORDER.indexOf(b[0]),
    );
  }, [news]);

  const when = (iso: string | null) => {
    if (!iso) return '';
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 45) return 'الآن';
    if (s < 3600) return `${Math.round(s / 60)} د`;
    if (s < 86400) return `${Math.round(s / 3600)} س`;
    return `${Math.round(s / 86400)} ي`;
  };

  return (
    <section className="sdrv" dir="rtl">
      <NewsTicker items={tickerItems} />

      <header className="sdrv__head">
        <h2>العوامل المؤثرة في سوق السكر</h2>
        <div className="sdrv__meta">
          {loading ? 'جارِ التحميل…' : error ? <span className="sdrv__err">{error}</span> : `آخر تحديث ${when(updatedAt) || '—'}`}
          <button type="button" onClick={load} disabled={loading} className="sdrv__refresh">
            تحديث
          </button>
        </div>
      </header>

      <nav className="sdrv__tabs" role="tablist">
        {(
          [
            ['drivers', `المؤشرات (${macro.filter((m) => m.ok).length})`],
            ['news', `الأخبار (${news.length})`],
            ['weather', `الطقس (${weather.filter((w) => w.ok).length})`],
            ['files', UPLOAD_ENABLED ? `الملفات (${uploaded.length})` : 'الملفات (معطّل)'],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'drivers' && (
        <div className="sdrv__grid">
          {macro.map((m) => (
            <article key={m.symbol} className={`driver ${m.ok ? '' : 'driver--down'}`}>
              <div className="driver__top">
                <h3>{m.ar}</h3>
                <span className={`driver__impact driver__impact--${m.impact}`}>
                  {m.impact === 'high' ? 'أثر عالٍ' : 'أثر متوسط'}
                </span>
                <span className="driver__sym">{m.symbol}</span>
              </div>
              <div className="driver__val">
                {m.ok && m.last != null ? m.last.toFixed(m.symbol === 'BZ=F' || m.symbol === 'DX-Y.NYB' ? 3 : 4) : '—'}
                {m.change != null && (
                  <em className={m.change > 0 ? 'up' : m.change < 0 ? 'dn' : 'flat'}>
                    {m.change > 0 ? '+' : ''}
                    {m.change.toFixed(4)} ({m.changePct?.toFixed(2)}%)
                  </em>
                )}
              </div>
              <p>{m.whyAr}</p>
            </article>
          ))}
        </div>
      )}

      {tab === 'news' && (
        <div className="news">
          {byTopic.map(([topic, list]) => (
            <div key={topic} className="news__group">
              <h3 className="news__topic">{list[0].topicAr}</h3>
              <ul>
                {list.map((n, i) => (
                  <li key={`${topic}-${i}`}>
                    <a href={n.link} target="_blank" rel="noreferrer noopener">
                      {n.title}
                    </a>
                    <span className="news__src">
                      {n.source} · {when(n.publishedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {tab === 'weather' && (
        <div className="wx">
          {weather.map((w) => {
            const heavy = (w.rainDay ?? 0) >= 10;
            const light = (w.rainDay ?? 0) > 0 && !heavy;
            return (
              <article key={w.key} className={`wxcard${w.ok ? '' : ' driver--down'}`}>
                <div className="wxcard__top">
                  <h3>{w.ar}</h3>
                  <span className={`wxcard__badge ${heavy ? 'is-heavy' : light ? 'is-rain' : 'is-dry'}`}>
                    {heavy ? 'أمطار غزيرة' : light ? 'أمطار' : 'جاف'}
                  </span>
                </div>
                <div className="wxcard__temp">{w.ok && w.temp != null ? `${Math.round(w.temp)}°` : '—'}</div>
                <dl>
                  <div><dt>هطول اليوم</dt><dd>{w.rainDay != null ? `${w.rainDay} mm` : '—'}</dd></div>
                  <div><dt>هطول الآن</dt><dd>{w.rainNow != null ? `${w.rainNow} mm` : '—'}</dd></div>
                  <div><dt>أعلى حرارة</dt><dd>{w.tmax != null ? `${Math.round(w.tmax)}°C` : '—'}</dd></div>
                  <div><dt>الرياح</dt><dd>{w.wind != null ? `${Math.round(w.wind)} km/h` : '—'}</dd></div>
                </dl>
                <p className="wxcard__note">
                  {heavy
                    ? 'هطول غزير قد يوقف التموير ويؤخر السحق في المنطقة.'
                    : light
                      ? 'هطول خفيف — راقب أثره على نمو القصب.'
                      : 'لا هطول مؤثر — راقب الحرارة والجفاف.'}
                </p>
              </article>
            );
          })}
        </div>
      )}

      {tab === 'files' && (
        <div className="files">
          {UPLOAD_ENABLED ? (
            <>
          <div
            className={`drop ${drag ? 'is-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void send([...e.dataTransfer.files]);
            }}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.docx,.xlsx,.xls"
              hidden
              onChange={(e) => void send([...(e.target.files ?? [])])}
            />
            <strong>اسحب ملفات التقرير هنا أو اضغط للاختيار</strong>
            <span>PDF · Word · Excel — حتى 12 MB</span>
          </div>

          {uploadMsg && <p className={`files__msg ${uploadMsg.ok ? 'ok' : 'bad'}`}>{busy ? 'جارِ التحليل…' : uploadMsg.text}</p>}

          <ul className="files__list">
            {uploaded.map((u) => (
              <li key={u.id}>
                <div className="files__row">
                  <em className="files__topic">{u.topicAr}</em>
                  <span className="files__file">{u.file}</span>
                  <span className="files__rel">{u.relevance}</span>
                </div>
                <p>{u.text}</p>
              </li>
            ))}
            {!uploaded.length && <li className="files__empty">لم تُرفع ملفات بعد.</li>}
          </ul>
            </>
          ) : (
            <div className="files__off">
              <strong>رفع التقارير معطّل مؤقتاً</strong>
              <span>
                التخزين على هذا الخادم للقراءة فقط، والرفع يحتاج قرصاً دائماً. تُبقى بيانات المؤشرات
                والأخبار والطقس ومقترح الشراء تعمل بشكل طبيعي.
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}