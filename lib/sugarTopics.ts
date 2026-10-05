export type Topic = { topic: string; ar: string; en: string };

/**
 * Sugar-specific driver taxonomy, matched in English and Arabic.
 * Used to tag live news by its actual content (not by search query) and to score
 * lines extracted from uploaded PDF/Excel/Word briefings.
 */
export const TOPICS: (Topic & { terms: string[] })[] = [
  {
    topic: 'brazil', ar: 'البرازيل', en: 'Brazil',
    terms: ['brazil', 'brazilian', 'brasil', 'center-south', 'centro-sul', 'cane', 'cané', 'crush', 'moagem', 'atr', 'sucrose', 'uniao', 'udop', 'conab', 'alambique', 'البرازيل', 'قصب', 'بامبو', 'عصير', 'سحق'],
  },
  {
    topic: 'india', ar: 'الهند', en: 'India',
    terms: ['india', 'indian', 'isma', 'nfcsf', 'dfpd', 'export quota', 'export duty', 'subsidy', 'ethanol', 'esr', 'frc', 'cane crush', 'mill', 'isr', 'الهند', 'الهندي', 'حصة', 'دعم', 'تصدير', 'مطحنة'],
  },
  {
    topic: 'thailand', ar: 'تايلاند', en: 'Thailand',
    terms: ['thailand', 'thai', 'tsc', 'ocsb', 'counter-season', 'counter season', 'تايلاند', 'تايلاندي'],
  },
  {
    topic: 'energy', ar: 'الطاقة والإيثانول', en: 'Energy & ethanol',
    terms: ['ethanol', 'gasohol', 'brent', 'wti', 'crude', 'oil price', 'gasoline', 'renewable fuel', 'renova', 'corn ethanol', 'الإيثانول', 'نفط', 'بنزين', 'وقود'],
  },
  {
    topic: 'policy', ar: 'السياسات والحصص', en: 'Policy & quotas',
    terms: ['tariff', 'quota', 'trq', 'subsidy', 'export restriction', 'export ban', 'duty', 'biofuel mandate', 'renbio', 'policy', 'regulation', 'حصة', 'حصص', 'رسوم', 'سياسة', 'تقييد', 'الوقود الحيوي'],
  },
  {
    topic: 'weather', ar: 'الطقس والمناخ', en: 'Weather & climate',
    terms: ['monsoon', 'rainfall', 'drought', 'frost', 'rain', 'climate', 'el nino', 'el niño', 'la nina', 'storm', 'dry weather', 'wet weather', 'أمطار', 'موسم الأمطار', 'جفاف', 'صقيع', 'مناخ', 'إلينيو'],
  },
  {
    topic: 'stocks', ar: 'المخزون', en: 'Stocks & balance',
    terms: ['stock', 'stocks', 'inventory', 'carryover', 'surplus', 'deficit', 'loat', 'ending stocks', 'balance sheet', 'tight supply', 'oversupply', 'مخزون', 'مخزونات', 'فائض', 'عجز'],
  },
  {
    topic: 'market', ar: 'بنية السوق', en: 'Market structure',
    terms: ['ice', 'no. 11', 'no.11', 'no11', 'sb1', 'spread', 'backwardation', 'contango', 'premium', 'basis', 'futures', 'raw sugar', 'white sugar', 'الفارق', 'علاوة', 'تدرج', 'سكر خام'],
  },
  {
    topic: 'currency', ar: 'العملات', en: 'Currencies',
    terms: ['brl', 'brazilian real', 'rupee', 'baht', 'real', 'fx', 'exchange rate', 'devaluation', 'ريال', 'روبية', 'باهت', 'صرف', 'عملة'],
  },
  {
    topic: 'quake', ar: 'زلازل', en: 'Earthquake',
    terms: ['earthquake', 'quake', 'magnitude', 'tremor', 'aftershock', 'seismic', 'زلزال', 'زلازل', 'هزة', 'شدة الزلزال'],
  },
  {
    topic: 'geopolitics', ar: 'جيوسياسة وحرب', en: 'Geopolitics & conflict',
    terms: ['war', 'warfare', 'strike', 'airstrike', 'missile', 'invasion', 'conflict', 'militant', 'houthi', 'sanction', 'embargo', 'ceasefire', 'حرب', 'غزو', 'صاروخ', 'اشتباك', 'عقوبات', 'هجوم'],
  },
  {
    topic: 'shipping', ar: 'الشحن والمضايق', en: 'Shipping & straits',
    terms: ['strait', 'hormuz', 'red sea', 'suez', 'panama', 'tanker', 'vessel', 'shipping', 'freight', 'port closure', 'reroute', 'transit', 'مضيق', 'هرمز', 'البحر الأحمر', 'السويس', 'ناقلة', 'شحن', 'ميناء', 'تأمين'],
  },
];

export function classify(text: string): (Topic & { terms: string[] })[] {
  const low = (text || '').toLowerCase();
  const hits = TOPICS.map((g) => ({ ...g, terms: g.terms.filter((t) => low.includes(t)) }));
  return hits.filter((h) => h.terms.length > 0).sort((a, b) => b.terms.length - a.terms.length);
}

/** Content-based primary topic; returns null when nothing sugar-specific matches. */
export function primaryTopic(text: string): (Topic & { terms: string[] }) | null {
  return classify(text)[0] ?? null;
}