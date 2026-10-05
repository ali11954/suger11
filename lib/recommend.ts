/**
 * Procurement decision support for ICE Sugar No.11.
 *
 * Every input is a number already shown on this dashboard, and every weight is
 * written down here, so a buyer can audit or re-tune the call. The output is a
 * coverage plan (how much of the requirement to fix now, at what limit price,
 * in how many tranches) — not a price prediction.
 *
 * Sign convention: a positive factor score means "supports buying now".
 */

export type Factor = {
  key: string;
  ar: string;
  en: string;
  /** Human-readable reading the score was derived from. */
  reading: string;
  /** Normalised -1..+1 */
  score: number;
  /** Relative importance, 0..1 */
  weight: number;
};

export type Action = 'buy_now' | 'buy_gradual' | 'hold' | 'wait' | 'avoid';

/**
 * Sum of every factor weight. Missing inputs divide by this total instead of by
 * the weights that happened to resolve, so a dropped (often bearish) reading
 * pulls the score toward neutral rather than silently inflating it.
 */
const TOTAL_WEIGHT = 0.22 + 0.18 + 0.12 + 0.16 + 0.12 + 0.1 + 0.14 + 0.1;

export type Recommendation = {
  net: number;
  action: Action;
  actionAr: string;
  actionEn: string;
  /** Share of the requirement to price now, 0..1 */
  fixNow: number;
  /** Suggested limit price for the first tranche (US cents/lb). */
  limitPrice: number | null;
  /** Regression fair value over the horizon. */
  fairValue: number | null;
  /** Spread of last vs fair value, %. */
  edgePct: number | null;
  tranches: { pct: number; trigger: string; triggerAr: string }[];
  factors: Factor[];
  confidence: number;
  confidenceAr: string;
  /** Factor keys that had no usable reading this cycle. */
  missing: string[];
  horizonDays: number;
  caveats: string[];
  generatedAt: string;
};

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Ordinary least squares slope/intercept/r2 for the close series. */
export function linreg(ys: number[]): { slope: number; intercept: number; r2: number; stdErr: number } | null {
  const n = ys.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += ys[i]; sxy += i * ys[i]; sxx += i * i;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;

  // Residuals computed directly; an algebraic SSE shortcut overflowed r2 past 1.
  let sse = 0;
  let syy = 0;
  const mean = sy / n;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * i);
    sse += r * r;
    const d = ys[i] - mean;
    syy += d * d;
  }
  const r2 = syy > 0 ? Math.max(0, Math.min(1, 1 - sse / syy)) : 0;
  const stdErr = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  return { slope, intercept, r2, stdErr };
}

const shape = (v: number) => (Math.abs(v) < 0.15 ? 'مستقر' : v > 0 ? 'Backwardation' : 'Contango');

export type Inputs = {
  /** Near contract. */
  last: number | null;
  /** Regression slope per bar on the near contract. */
  slopePerBar: number | null;
  /** Regression r-squared: how much the trend actually explains. */
  r2: number | null;
  bars: number;
  /** Cash front month minus near contract, %. Positive = backwardation. */
  cashCurvePct: number | null;
  /** Near contract minus next contract, %. Positive = backwardation. */
  rollCurvePct: number | null;
  /** 5-day % change for each macro. */
  brlPct: number | null;
  brentPct: number | null;
  dxyPct: number | null;
  /** Brazil Centre-South daily rainfall, mm. */
  brazilRain: number | null;
  /** Count of hazard headlines in the feed. */
  hazardNews: number;
  /** Sugar-specific bearish/bullish headline count. */
  sugarNews: number;
  /** Age of the underlying Stooq snapshot, hours. */
  snapshotAgeH: number | null;
  /** macro symbols that resolved */
  macroOk: number;
  macroTotal: number;
};

const ACTION_TABLE: { min: number; action: Action; ar: string; en: string; fix: number }[] = [
  { min: 45, action: 'buy_now', ar: 'شراء وتثبيت قوي', en: 'Buy & fix aggressively', fix: 0.65 },
  { min: 20, action: 'buy_gradual', ar: 'شراء تدريجي', en: 'Buy gradually', fix: 0.4 },
  { min: -20, action: 'hold', ar: 'احتفظ — تثبيت محدود', en: 'Hold — limited fix', fix: 0.2 },
  { min: -45, action: 'wait', ar: 'انتظر — قلّل التثبيت', en: 'Wait — reduce fixing', fix: 0.1 },
  { min: -101, action: 'avoid', ar: 'تجنّب الشراء الآن', en: 'Avoid buying now', fix: 0.05 },
];

export function buildRecommendation(i: Inputs): Recommendation {
  const f: Factor[] = [];
  const add = (key: string, ar: string, en: string, reading: string, score: number, weight: number) => {
    if (!Number.isFinite(score) || weight <= 0) return;
    f.push({ key, ar, en, reading, score: clamp(score), weight });
  };

  // 1) Price trend of the near contract.
  if (i.last != null && i.slopePerBar != null && i.bars > 2) {
    const windowMove = (i.slopePerBar * i.bars) / i.last;
    // +/-5% across the window saturates the score.
    add('trend', 'اتجاه عقد التسليم', 'Near-contract trend', `${(windowMove * 100).toFixed(1)}% عبر ${i.bars} جلسة`, windowMove / 0.05, 0.22);
  }

  // 2) Curve: backwardation (cash above forward) means tight nearby supply.
  if (i.cashCurvePct != null) {
    add(
      'cash_curve',
      'الفارق الكاش/الأقرب',
      'Cash vs near spread',
      `${shape(i.cashCurvePct)} ${Math.abs(i.cashCurvePct).toFixed(2)}%`,
      i.cashCurvePct / 5,
      0.18,
    );
  }

  // 3) Roll: contango discourages carrying the near contract.
  if (i.rollCurvePct != null) {
    add(
      'roll_curve',
      'فارق مارس/مايو',
      'Near vs next spread',
      `${shape(i.rollCurvePct)} ${Math.abs(i.rollCurvePct).toFixed(2)}%`,
      i.rollCurvePct / 5,
      0.12,
    );
  }

  // 4) Brazilian real: a stronger real raises USD sugar.
  if (i.brlPct != null) add('brl', 'الريال البرازيلي', 'BRL', `${i.brlPct >= 0 ? '+' : ''}${i.brlPct.toFixed(2)}% / 5d`, i.brlPct / 3, 0.16);

  // 5) Crude: ethanol parity pulls cane toward ethanol when oil rises.
  if (i.brentPct != null) add('brent', 'خام برنت', 'Brent', `${i.brentPct >= 0 ? '+' : ''}${i.brentPct.toFixed(2)}% / 5d`, i.brentPct / 5, 0.12);

  // 6) Dollar index: USD sugar is inversely related.
  if (i.dxyPct != null) add('dxy', 'مؤشر الدولار', 'Dollar index', `${i.dxyPct >= 0 ? '+' : ''}${i.dxyPct.toFixed(2)}% / 5d`, -i.dxyPct / 2, 0.1);

  // 7) Brazil rain: excess rain halts crushing and delays delivery.
  if (i.brazilRain != null) {
    const excess = (i.brazilRain - 6) / 12;
    add(
      'weather',
      'أمطار سانتوس',
      'Centre-South rain',
      `${i.brazilRain.toFixed(1)} mm/يوم ${i.brazilRain >= 10 ? '(غزيرة)' : i.brazilRain > 0 ? '(خفيفة)' : '(جاف)'}`,
      excess,
      0.14,
    );
  }

  // 8) Breaking-news risk premium from the wire.
  if (i.hazardNews > 0) {
    add('hazard', 'أخبار عاجلة', 'Breaking-risk headlines', `${i.hazardNews} خبر عاجل`, Math.min(i.hazardNews / 25, 1) * 0.6 + 0.15, 0.1);
  }

  const FACTOR_LABEL: Record<string, string> = {
  trend: 'اتجاه العقد', cash_curve: 'فارق الكاش', roll_curve: 'فارق Rolls',
  brl: 'الريال البرازيلي', brent: 'خام برنت', dxy: 'مؤشر الدولار',
  weather: 'طقوس البرازيل', hazard: 'الأخبار العاجلة',
};

const EXPECTED: Record<string, number> = {
    trend: 0.22, cash_curve: 0.18, roll_curve: 0.12, brl: 0.16,
    brent: 0.12, dxy: 0.1, weather: 0.14, hazard: 0.1,
  };
  const missing = Object.keys(EXPECTED).filter((k) => !f.some((x) => x.key === k));

  // Divide by the full weight budget, not just the resolved factors: a failed
  // bearish read (e.g. Brent) must pull the score toward neutral, not vanish.
  const net = (f.reduce((a, x) => a + x.score * x.weight, 0) / TOTAL_WEIGHT) * 100;

  const row = ACTION_TABLE.find((a) => net >= a.min) ?? ACTION_TABLE[ACTION_TABLE.length - 1];

  // Trend quality gates how much we trust the direction.
  const r2 = i.r2 ?? 0;
  let fix = row.fix;
  if (r2 < 0.15) fix *= 0.75;
  if (i.snapshotAgeH != null && i.snapshotAgeH > 72) fix *= 0.85;

  // Fair value from the regression, projected over the decision horizon.
  const horizonDays = 30;
  let fairValue: number | null = null;
  if (i.last != null && i.slopePerBar != null && i.r2 != null && r2 > 0.1) {
    const barsAhead = Math.min(i.bars, horizonDays / 7);
    fairValue = i.last + i.slopePerBar * barsAhead;
  }
  const edgePct = fairValue != null && i.last ? ((fairValue - i.last) / i.last) * 100 : null;

  // Limit price: lean into the signal, never chase more than 1.5%.
  let limitPrice: number | null = null;
  if (i.last != null) {
    const tilt = net >= 45 ? 1.012 : net >= 20 ? 1.006 : net <= -45 ? 0.985 : net <= -20 ? 0.992 : 1.0;
    limitPrice = Math.round(i.last * tilt * 100) / 100;
  }

  const up = net >= 20;
  const down = net <= -20;
  const tranches = [
    { pct: Math.round(fix * 100 * 0.5), trigger: 'Now — secure the first half of the intended fix', triggerAr: 'الآن — تأمين نصف الكمية المقررة' },
    {
      pct: Math.round(fix * 100 * 0.3),
      trigger: up ? 'If price stays within 1% of the limit, add the second tranche' : 'On any pullback toward the fair value, add the second tranche',
      triggerAr: up ? 'إذا بقي السعر ضمن 1% من الحد، أضف الشريحة الثانية' : 'عند أي تراجع نحو القيمة العادلة، أضف الشريحة الثانية',
    },
    {
      pct: Math.round(fix * 100 * 0.2),
      trigger: down ? 'Hold back unless the curve re-tightens (backwardation)' : 'Hold back; revisit after the next balance-sheet report',
      triggerAr: down ? 'احتجز الباقي ما لم يشتد المنحنى من جديد' : 'احتجز الباقي؛ راجع بعد تقرير الميزان التالي',
    },
  ].filter((t) => t.pct > 0);

  let confidence = 40 + r2 * 45;
  if (i.macroTotal > 0) confidence += (i.macroOk / i.macroTotal) * 15;
  if (i.snapshotAgeH != null && i.snapshotAgeH <= 24) confidence += 5;
  confidence = Math.round(Math.max(20, Math.min(95, confidence)) - missing.length * 6);
  confidence = Math.max(15, Math.min(95, confidence));

  const caveats = [
    'الأسعار المتأخرة وليست تنفيذاً فعلياً؛ التزم بسعر المحصل الوسيط.',
    'مصدر عقود التسليم لقطة Stooq يومية وليست تدفّقاً لحظياً؛ حدّثها بـ npm run fetch:contracts.',
    'هذا دعم للقرار مبني على الأرقام المعروضة أعلاه، وليس توصية استثمارية أو ضماناً للسعر.',
  ];

  return {
    net: Math.round(net * 10) / 10,
    action: row.action,
    actionAr: row.ar,
    actionEn: row.en,
    fixNow: Math.round(fix * 100) / 100,
    limitPrice,
    fairValue: fairValue != null ? Math.round(fairValue * 100) / 100 : null,
    edgePct: edgePct != null ? Math.round(edgePct * 100) / 100 : null,
    tranches,
    factors: f.sort((a, b) => b.weight - a.weight),
    confidence,
    confidenceAr: confidence >= 70 ? 'ثقة عالية' : confidence >= 50 ? 'ثقة متوسطة' : 'ثقة منخفضة',
    missing: missing.map((k) => FACTOR_LABEL[k] ?? k),
    horizonDays,
    caveats,
    generatedAt: new Date().toISOString(),
  };
}