/**
 * ICE Sugar No.11 delivery calendar.
 *
 * No.11 trades against a fixed six-month cycle: March, May, July, September,
 * November and January. Yahoo only publishes a rolled continuous ticker (SB=F)
 * and 404s on individual months, so per-contract pricing comes from the Stooq
 * snapshot in data/contracts.json.
 *
 * Month codes follow the futures convention: H=Mar, K=May, N=Jul, U=Sep, V=Nov, Z=Jan.
 */

export type CycleMonth = { code: string; month: number };

export const ICE_CYCLE: CycleMonth[] = [
  { code: 'H', month: 3 },
  { code: 'K', month: 5 },
  { code: 'N', month: 7 },
  { code: 'U', month: 9 },
  { code: 'V', month: 11 },
  { code: 'Z', month: 1 },
];

export type ContractRef = {
  symbol: string;
  /** Delivery month as ISO date, e.g. 2027-03-01 */
  deliveryISO: string;
  deliveryMonth: number;
  deliveryYear: number;
  labelAr: string;
  labelEn: string;
};

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseContract(symbol: string): ContractRef | null {
  const m = /^SB([HKNUVZ])(\d{2})$/i.exec(symbol.trim());
  if (!m) return null;
  const code = m[1].toUpperCase();
  const hit = ICE_CYCLE.find((c) => c.code === code);
  if (!hit) return null;
  const year = 2000 + Number(m[2]);
  return {
    symbol: symbol.toUpperCase(),
    deliveryISO: `${year}-${String(hit.month).padStart(2, '0')}-01`,
    deliveryMonth: hit.month,
    deliveryYear: year,
    labelAr: `${AR_MONTHS[hit.month - 1]} ${year}`,
    labelEn: `${EN_MONTHS[hit.month - 1]} ${year}`,
  };
}

/** Whole months from today until the delivery month. Negative means already past. */
export function monthsUntil(iso: string, now = new Date()): number {
  const [y, m] = iso.split('-').map(Number);
  return (y - now.getFullYear()) * 12 + (m - (now.getMonth() + 1));
}

export type NearContract = ContractRef & {
  monthsOut: number;
  /** True when every tracked delivery month has already started. */
  expired: boolean;
  /** The contract we roll to once this one is done. */
  next: ContractRef | null;
};

/**
 * Pick the nearest contract that has not started delivery yet.
 * Only considers contracts that are actually priced in the snapshot, so we
 * never point the chart at a month we have no data for.
 */
export function resolveNear(symbols: string[], now = new Date()): NearContract | null {
  const refs = symbols.map(parseContract).filter((r): r is ContractRef => r !== null);
  if (!refs.length) return null;

  const priced = refs
    .map((r) => ({ r, m: monthsUntil(r.deliveryISO, now) }))
    .filter((x) => x.m >= 0)
    .sort((a, b) => a.m - b.m);

  // Nothing in the future yet: keep the most recently expired month (largest
  // monthsOut) rather than the oldest one, and flag it so the UI can say so.
  const expired = refs.length > 0 && priced.length === 0;
  const pool = priced.length
    ? priced
    : refs
        .map((r) => ({ r, m: monthsUntil(r.deliveryISO, now) }))
        .sort((a, b) => b.m - a.m);
  const head = pool[0];
  if (!head) return null;

  const after = refs
    .filter((r) => monthsUntil(r.deliveryISO, now) > head.m)
    .sort((a, b) => monthsUntil(a.deliveryISO, now) - monthsUntil(b.deliveryISO, now));

  return { ...head.r, monthsOut: head.m, expired, next: after[0] ?? null };
}

export function rollHint(near: NearContract | null): string {
  if (!near) return '';
  if (near.expired) return `انتهت كل العقود المتتبعة — حدّث اللقطة`;
  if (near.monthsOut === 0) return `ينتقل تلقائياً إلى ${near.next ? near.next.labelEn : 'العقد التالي'} عند انتهاء ${near.labelEn}`;
  return `${near.labelEn} • ينتقل تلقائياً إلى ${near.next ? near.next.labelEn : 'العقد التالي'}`;
}