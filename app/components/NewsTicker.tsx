'use client';
import { useEffect, useRef, useState } from 'react';

export type TickerItem = {
  id: string;
  text: string;
  topic?: string;
  topicAr?: string;
  source?: string;
  href?: string;
  origin?: 'live' | 'upload';
};

type Props = {
  items: TickerItem[];
  labelAr?: string;
  labelEn?: string;
  lang?: 'ar' | 'en';
};

export default function NewsTicker({ items, labelAr = 'عوامل السكر', labelEn = 'Sugar drivers', lang = 'ar' }: Props) {
  const [speed, setSpeed] = useState(1);
  const trackRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(60);

  // Scale scroll speed with content length so long feeds do not crawl.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const half = el.scrollWidth / 2;
    if (half > 0) setDuration(Math.min(105, Math.max(18, half / 170)));
  }, [items]);

  if (!items.length) {
    return (
      <div className="ticker ticker--empty">
        <span className="ticker__label">{lang === 'ar' ? labelAr : labelEn}</span>
        <span className="ticker__idle">{lang === 'ar' ? 'لا توجد عوامل بعد' : 'No drivers yet'}</span>
      </div>
    );
  }

  const run = [...items, ...items];

  return (
    <div className="ticker">
      <span className="ticker__label">
        <span className="ticker__live" />
        {lang === 'ar' ? labelAr : labelEn}
      </span>

      <div className="ticker__viewport">
        <div
          ref={trackRef}
          className="ticker__track"
          style={{ animationDuration: `${duration / speed}s` }}
        >
          {run.map((it, i) => (
            <span className="ticker__item" key={`${it.id}-${i}`}>
              {it.origin === 'upload' && <em className="ticker__tag ticker__tag--file">{lang === 'ar' ? 'ملف' : 'file'}</em>}
              {it.topic && <em className="ticker__tag">{lang === 'ar' ? it.topicAr : it.topic}</em>}
              {it.href ? (
                <a href={it.href} target="_blank" rel="noreferrer noopener">
                  {it.text}
                </a>
              ) : (
                it.text
              )}
              {it.source && <span className="ticker__src">{it.source}</span>}
            </span>
          ))}
        </div>
      </div>

      <div className="ticker__ctl">
        <button type="button" onClick={() => setSpeed((s) => Math.min(3, s + 0.5))} title="faster">
          +
        </button>
        <button type="button" onClick={() => setSpeed((s) => Math.max(0.5, s - 0.5))} title="slower">
          −
        </button>
      </div>
    </div>
  );
}