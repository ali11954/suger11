import { NextResponse } from 'next/server';
import { primaryTopic } from '../../../lib/sugarTopics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const TTL_MS = 10 * 60 * 1000;
type Cache = { at: number; macro: unknown[]; news: unknown[]; weather: unknown };
let cache: Cache | null = null;

/**
 * News is fetched from 10 RSS queries and Google throttles bursts, so a cold
 * cache can take 10-40s. Persist the last good build to disk and serve it
 * immediately, then refresh in the background. This is what keeps the ticker
 * from sitting empty on page load or after a restart.
 */
const CACHE_FILE = 'drivers-cache.json';
let refreshing: Promise<Cache> | null = null;

async function readDisk(): Promise<Cache | null> {
  try {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const raw = await fs.readFile(path.join(process.cwd(), 'data', CACHE_FILE), 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j.at !== 'number' || !Array.isArray(j.news)) return null;
    return { at: j.at, macro: j.macro ?? [], news: j.news, weather: j.weather ?? [] };
  } catch {
    return null;
  }
}

async function writeDisk(c: Cache) {
  try {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const file = path.join(process.cwd(), 'data', CACHE_FILE);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(c));
    await fs.rename(tmp, file);
  } catch {
    /* cache write is best-effort */
  }
}

/**
 * Weather snapshot for the producing belt. Open-Meteo needs no key.
 * Santos/Porto Feliz covers Centre-South cane; the other two cover India and
 * Thailand, so the drivers panel can warn about rain, storms and heat that
 * actually threaten the crop.
 */
const WEATHER_SITES = [
  { key: 'brazil', ar: 'البرازيل — سانتوس', en: 'Brazil — Santos', lat: -23.96, lon: -46.33 },
  { key: 'india', ar: 'الهند — Lucknow', en: 'India — Lucknow', lat: 26.85, lon: 80.95 },
  { key: 'thailand', ar: 'تايلاند — Nakhon', en: 'Thailand — Nakhon', lat: 14.97, lon: 100.05 },
];

async function buildWeather() {
  const out = [];
  for (const s of WEATHER_SITES) {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}` +
      `&current=temperature_2m,precipitation,wind_speed_10m&daily=precipitation_sum,temperature_2m_max` +
      `&timezone=auto&forecast_days=1`;
    try {
      const xml = await fetchText(url, 2);
      if (!xml) throw new Error('no payload');
      const j = JSON.parse(xml);
      const rain = j?.daily?.precipitation_sum?.[0];
      out.push({
        ...s,
        temp: j?.current?.temperature_2m ?? null,
        rainNow: j?.current?.precipitation ?? null,
        rainDay: rain ?? null,
        wind: j?.current?.wind_speed_10m ?? null,
        tmax: j?.daily?.temperature_2m_max?.[0] ?? null,
        ok: true,
      });
    } catch {
      out.push({ ...s, temp: null, rainNow: null, rainDay: null, wind: null, tmax: null, ok: false });
    }
    await sleep(120);
  }
  return out;
}

/**
 * Macro factors that actually drive ICE Sugar No.11.
 * Brazil and crude oil are the dominant pair: Brazil is ~40% of world supply and
 * decides cane allocation between sugar and ethanol based on the sugar/ethanol spread.
 */
const MACRO: {
  symbol: string;
  key: string;
  ar: string;
  en: string;
  impact: 'high' | 'medium';
  whyAr: string;
  whyEn: string;
}[] = [
  {
    symbol: 'BRLUSD=X',
    key: 'brl',
    ar: 'الريال البرازيلي',
    en: 'Brazilian real (BRL/USD)',
    impact: 'high',
    whyAr: 'البرازيل أكبر منتج عالمي (نحو 40% من المعروض) — ارتفاع الريال يرفع سعر السكر بالدولار.',
    whyEn: 'Brazil is the largest producer (~40% of world supply); a stronger real lifts USD-denominated sugar.',
  },
  {
    symbol: 'BZ=F',
    key: 'brent',
    ar: 'خام برنت',
    en: 'Brent crude oil',
    impact: 'high',
    whyAr: 'هامش الإيثانول يتبع النفط، وقصب القصب ينافس بين السكر والإيثانول، فرفع أسعار النفط يدعم تخصيص السكر.',
    whyEn: 'Ethanol margins track crude; cane competes between sugar and ethanol, so higher oil supports sugar.',
  },
  {
    symbol: 'DX-Y.NYB',
    key: 'dxy',
    ar: 'مؤشر الدولار الأمريكي',
    en: 'US dollar index',
    impact: 'medium',
    whyAr: 'السكر يُسعّر بالدولار — ارتفاع مؤشر الدولار يضغط على السعر عادةً.',
    whyEn: 'Sugar is USD-denominated; a stronger dollar generally pressures the price.',
  },
  {
    symbol: 'INRUSD=X',
    key: 'inr',
    ar: 'الروبية الهندية',
    en: 'Indian rupee',
    impact: 'medium',
    whyAr: 'الهند ثاني أكبر مصدّر — عملتها وحصص التصدير والدعم تحرك منحنى الأسعار.',
    whyEn: 'India is the second-biggest exporter; its currency, export quota and subsidy drive the curve.',
  },
  {
    symbol: 'THBUSD=X',
    key: 'thb',
    ar: 'البات التايلندي',
    en: 'Thai baht',
    impact: 'medium',
    whyAr: 'تايلاند منتج كبير — تحركات البات تؤثر على عروض التصدير الآسيوية.',
    whyEn: 'Thailand is a major producer; baht moves shift Asian export offers.',
  },
];

const NEWS_QUERIES: { q: string; topic: string; ar: string; en: string }[] = [
  { q: 'raw sugar prices Brazil production', topic: 'brazil', ar: 'البرازيل', en: 'Brazil' },
  { q: 'India sugar production export subsidy', topic: 'india', ar: 'الهند', en: 'India' },
  { q: 'Thailand sugar production', topic: 'thailand', ar: 'تايلاند', en: 'Thailand' },
  { q: 'sugar futures ICE market', topic: 'market', ar: 'سوق السكر', en: 'Sugar market' },
];

/**
 * World-event wire for the ticker: the things that physically move cane and
 * freight — weather hazards in the producing belt, plus conflict/strait
 * closures that hit shipping routes.
 */
const WORLD_QUERIES: { q: string; topic: string; ar: string; en: string }[] = [
  { q: 'Brazil heavy rainstorm flooding crop', topic: 'weather', ar: 'الطقس', en: 'Weather' },
  { q: 'India cyclone storm rainfall crop damage', topic: 'weather', ar: 'الطقس', en: 'Weather' },
  { q: 'Thailand earthquake magnitude', topic: 'quake', ar: 'زلازل', en: 'Earthquake' },
  { q: 'Strait of Hormuz shipping closure war', topic: 'geopolitics', ar: 'جيوسياسة', en: 'Geopolitics' },
  { q: 'Red Sea shipping attack tanker disruption', topic: 'geopolitics', ar: 'شحن', en: 'Shipping' },
  { q: 'drought frost La Nina crop weather sugar cane', topic: 'weather', ar: 'مناخ', en: 'Climate' },
];

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#39;': "'",
};

function decode(s: string) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m.replace(/&|;/g, '')] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagOf(xml: string, block: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decode(m[1]) : '';
}

function parseRss(xml: string) {
  const out: { title: string; link: string; source: string; publishedAt: string | null }[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const title = tagOf(xml, b, 'title');
    if (!title) continue;
    out.push({
      title,
      link: tagOf(xml, b, 'link'),
      source: tagOf(xml, b, 'source') || 'Google News',
      publishedAt: (() => {
        const t = Date.parse(tagOf(xml, b, 'pubDate'));
        return Number.isFinite(t) ? new Date(t).toISOString() : null;
      })(),
    });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sequential fetch with backoff. Bursting 10 parallel requests gets us throttled to empty results. */
async function fetchText(url: string, tries = 3): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store', headers: { 'User-Agent': UA } });
      if (r.ok) return await r.text();
      if (r.status === 429 || r.status >= 500) {
        await sleep(400 * (i + 1) * (i + 1));
        continue;
      }
      return null;
    } catch {
      await sleep(300 * (i + 1));
    }
  }
  return null;
}

async function buildMacro() {
  const macro = [];
  for (const m of MACRO) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.symbol)}?range=5d&interval=1d`;
    let row: Record<string, unknown> = { ...m, last: null, change: null, changePct: null, ok: false };
    for (let i = 0; i < 2; i++) {
      const xml = await fetchText(url, 2);
      if (!xml) {
        await sleep(300);
        continue;
      }
      try {
        const res = JSON.parse(xml)?.chart?.result?.[0];
        if (!res) break;
        const meta = res.meta ?? {};
        const closes: number[] = (res.indicators?.quote?.[0]?.close ?? []).filter(
          (v: unknown): v is number => typeof v === 'number',
        );
        const last = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : closes[closes.length - 1];
        const prev = closes.length >= 2 ? closes[closes.length - 2] : null;
        const change = last != null && prev != null ? last - prev : null;
        row = {
          ...m,
          last: last ?? null,
          change,
          changePct: change != null && prev ? (change / prev) * 100 : null,
          ok: true,
        };
        break;
      } catch {
        await sleep(250);
      }
    }
    macro.push(row);
  }
  return macro;
}

async function buildNews() {
  const all = [...NEWS_QUERIES, ...WORLD_QUERIES];
  const perQuery = [];
  for (const q of all) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q.q + ' when:7d')}&hl=en-US&gl=US&ceid=US:en`;
    const xml = await fetchText(url, 3);
    perQuery.push(xml ? parseRss(xml) : []);
    await sleep(200);
  }

  const seen = new Set<string>();
  return perQuery
    .flat()
    .filter((n) => {
      const k = n.title.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((n) => {
      // Tag by what the headline actually says, not by which query returned it.
      const t = primaryTopic(`${n.title} ${n.source}`);
      return { ...n, topic: t?.topic ?? 'general', topicAr: t?.ar ?? 'عام', topicEn: t?.en ?? 'General', matched: t?.terms ?? [] };
    })
    .sort((a, b) => {
      // Sugar-specific headlines first, then newest.
      const rank = (x: typeof a) => (x.topic === 'general' ? 1 : 0);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0);
    })
    .slice(0, 80);
}

async function refresh(): Promise<Cache> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const macro = await buildMacro();
    const [news, weather] = await Promise.all([buildNews(), buildWeather()]);
    const c: Cache = { at: Date.now(), macro, news, weather };
    cache = c;
    await writeDisk(c);
    refreshing = null;
    return c;
  })();
  return refreshing;
}

export async function GET() {
  // Warm start: disk cache first so the ticker has content on the very first paint.
  if (!cache) cache = await readDisk();

  const fresh = cache && Date.now() - cache.at < TTL_MS;
  let data: Cache;
  if (fresh) {
    data = cache!;
  } else if (cache) {
    data = cache; // serve what we have, refresh behind the scenes
    void refresh().catch(() => undefined);
  } else {
    data = await refresh();
  }

  let uploads: unknown = null;
  try {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    uploads = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'drivers-upload.json'), 'utf8'));
  } catch {
    /* no uploads yet */
  }

  return NextResponse.json(
    {
      updatedAt: new Date().toISOString(),
      fetchedAt: new Date(data.at).toISOString(),
      cached: Boolean(fresh),
      refreshing: !fresh,
      macro: data.macro,
      news: data.news,
      weather: data.weather,
      uploads,
      counts: {
        macroOk: (data.macro as { ok: boolean }[]).filter((m) => m.ok).length,
        news: data.news.length,
        weatherOk: (data.weather as { ok: boolean }[]).filter((w) => w.ok).length,
        uploadItems: (uploads as { items?: unknown[] } | null)?.items?.length ?? 0,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}