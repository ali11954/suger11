#!/usr/bin/env node
/**
 * Sugar No.11 contract snapshot fetcher.
 *
 * Stooq publishes individual ICE sugar contracts (Mar/May 2027, front month) but
 * gates its pages behind a client-side SHA-256 proof-of-work challenge, so plain
 * server-side fetches get an empty shell. This drives the Chrome/Edge already
 * installed on the machine to solve that challenge the same way a human does,
 * then reads the rendered OHLC table.
 *
 * Writes data/contracts.json. The Next.js app only ever *reads* that JSON, so
 * the app itself gains no new dependency and no runtime cost.
 *
 * Usage:  node scripts/fetch-contracts.mjs
 * Env:    CHROME_PATH, PLAYWRIGHT_CORE_PATH (optional overrides)
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'data');
const OUT_FILE = path.join(OUT_DIR, 'contracts.json');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const PW_CANDIDATES = [
  process.env.PLAYWRIGHT_CORE_PATH,
  'playwright-core',
  'C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode\\pw\\node_modules\\playwright-core',
  path.join(ROOT, 'node_modules', 'playwright-core'),
].filter(Boolean);

const TARGETS = [
  { symbol: 'SBY00', stooq: 'sb.f', label: 'Cash', role: 'cash' },
  { symbol: 'SBH27', stooq: 'sbh27.f', label: 'Mar 2027', role: 'forward' },
  { symbol: 'SBK27', stooq: 'sbk27.f', label: 'May 2027', role: 'forward' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePw() {
  const req = createRequire(import.meta.url);
  for (const c of PW_CANDIDATES) {
    try { return req(c); } catch { /* keep looking */ }
  }
  return null;
}

const parseNum = (s) => {
  if (typeof s !== 'string') return null;
  const v = Number(s.replace(/[,%\s+]/g, '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(v) ? v : null;
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

async function main() {
  const pw = resolvePw();
  if (!pw) {
    console.error('[contracts] playwright-core not found. Install it, or set PLAYWRIGHT_CORE_PATH.');
    console.error('[contracts]   npm i -D playwright-core   (the app itself does not need it)');
    process.exit(2);
  }
  const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) {
    console.error('[contracts] No Chrome or Edge found. Set CHROME_PATH.');
    process.exit(2);
  }

  console.log(`[contracts] browser: ${executablePath}`);
  const browser = await pw.chromium.launch({
    executablePath,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const contracts = [];
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // Stooq serves a proof-of-work shell first; the browser solves it on reload.
    let solved = false;
    for (let attempt = 1; attempt <= 4 && !solved; attempt++) {
      try {
        await page.goto(`https://stooq.com/q/d/?s=${TARGETS[0].stooq}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page
          .waitForFunction(() => !/requires JavaScript to verify/i.test(document.documentElement.innerHTML || ''), { timeout: 45000 })
          .catch(() => {});
        solved = await page.evaluate(() => !/requires JavaScript to verify/i.test(document.documentElement.innerHTML || ''));
      } catch (e) {
        console.warn(`[contracts] warmup attempt ${attempt}: ${String(e.message).split('\n')[0].slice(0, 80)}`);
      }
      if (!solved) await sleep(5000);
    }
    console.log(solved ? '[contracts] challenge cleared' : '[contracts] warning: challenge not confirmed, continuing');

    for (const t of TARGETS) {
      let done = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        try {
          await page.goto(`https://stooq.com/q/d/?s=${t.stooq}&i=d`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          // Stooq can re-issue the proof-of-work shell; give the table time to render.
          await page
            .waitForFunction(
              () => {
                const b = document.body ? document.body.innerText : '';
                if (/requires JavaScript to verify/i.test(b)) return false;
                return [...document.querySelectorAll('table')].some((t) =>
                  [...t.querySelectorAll('tr')].some((tr) => {
                    const c = tr.querySelector('td');
                    return c && /^\d+$/.test(c.innerText.trim());
                  }),
                );
              },
              { timeout: 25000 },
            )
            .catch(() => {});
          const raw = await page.evaluate(() => {
            const body = document.body ? document.body.innerText : '';
            if (/requires JavaScript to verify/i.test(body)) return { challenged: true };
            if (/nie istnieje w bazie|does not exist/i.test(body)) return { missing: true };
            // Pick whichever table actually carries OHLC rows, not a fixed index.
            const scored = [...document.querySelectorAll('table')]
              .map((t) => {
                const trs = [...t.querySelectorAll('tr')];
                const n = trs.filter((tr) => {
                  const c = tr.querySelector('td');
                  return c && /^\d+$/.test(c.innerText.trim());
                }).length;
                return { t, n, len: trs.length };
              })
              .filter((x) => x.n > 0)
              .sort((a, b) => b.n - a.n || b.len - a.len)[0];
            if (!scored) return { missing: false, rows: [] };
            return {
              missing: false,
              rows: [...scored.t.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td,th')].map((c) => c.innerText.trim())),
            };
          });

          if (raw.challenged) throw new Error('proof-of-work challenge re-issued');
          if (raw.missing) throw new Error('symbol not in database');
          const rows = (raw.rows || []).filter((r) => /^\d/.test(r[0] ?? '') && parseDate(r[1]));
          if (!rows.length) throw new Error('no data rows');

          const head = rows[0];
          const close = parseNum(head[5]);
          const chgPct = parseNum(head[6]);
          const chg = parseNum(head[7]);
          contracts.push({
            symbol: t.symbol,
            stooqSymbol: t.stooq,
            label: t.label,
            role: t.role,
            available: close !== null,
            last: close,
            open: parseNum(head[2]),
            high: parseNum(head[3]),
            low: parseNum(head[4]),
            prevClose: close !== null && chg !== null ? close - chg : null,
            change: chg,
            changePct: chgPct,
            volume: parseNum(head[8]),
            openInterest: parseNum(head[9]),
            tradeDate: parseDate(head[1]),
            source: 'Stooq — ICE Sugar No.11',
            sourceUrl: `https://stooq.com/q/d/?s=${t.stooq}`,
            history: rows
              .map((r) => ({
                t: parseDate(r[1]),
                o: parseNum(r[2]),
                h: parseNum(r[3]),
                l: parseNum(r[4]),
                c: parseNum(r[5]),
              }))
              .filter((p) => p.t && p.c !== null)
              .reverse(),
          });
          console.log(`[contracts] ${t.symbol.padEnd(6)} ${t.label.padEnd(10)} last=${close} date=${parseDate(head[1])} rows=${rows.length}`);
          done = true;
        } catch (e) {
          console.warn(`[contracts] ${t.symbol} attempt ${attempt} failed: ${String(e.message).split('\n')[0].slice(0, 90)}`);
          await sleep(4000);
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (!contracts.length) {
    console.error('[contracts] no contracts retrieved; leaving existing snapshot untouched');
    process.exit(1);
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    method: 'local Chrome via playwright-core (Stooq proof-of-work solved in-browser)',
    contracts,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, OUT_FILE);
  console.log(`[contracts] wrote ${path.relative(ROOT, OUT_FILE)} (${contracts.length}/${TARGETS.length} symbols)`);
}

main().catch((e) => {
  console.error('[contracts] fatal:', e?.message ?? e);
  process.exit(1);
});