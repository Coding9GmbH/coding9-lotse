'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useT } from '@/lib/i18n/I18nProvider';
import type { SistrixOverview } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import styles from './Home.module.css';

/** Mini history as a line (no axes: the direction is what matters, the index is a relative number) */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 120, h = 32, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / span) * (h - 4)}`).join(' ');
  return <svg className={styles.spark} viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

const num = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: n < 1 ? 4 : 2 });

/** Home page card "Sistrix-Sichtbarkeit" (Sistrix visibility): only appears when Sistrix is connected. */
export function SistrixCard({ onAsk }: { onAsk: (text: string) => void }) {
  const t = useT().chat.home;
  const [o, setO] = useState<SistrixOverview | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let off = false;
    api.sistrixOverview().then(r => { if (!off) setO(r); }).catch(e => { if (!off) setErr(errorText(e)); });
    return () => { off = true; };
  }, []);
  if (o && !o.connected) return null;
  const values = (o?.series ?? []).map(p => p.value);
  return (
    <section className={`${styles.card} ${styles.sx}`} aria-labelledby="sx-h">
      <div className={styles.sxHead}>
        <b id="sx-h">{t.sistrixTitle}{o?.domain ? ` · ${o.domain}` : ''}</b>
        {o?.latest && <Button size="sm" onClick={() => onAsk(t.sistrixAskText)}>{t.sistrixAsk}</Button>}
      </div>
      {!o && !err && <p>{t.sistrixLoading}</p>}
      {err && <p role="alert">{t.sistrixError(err)}</p>}
      {o?.error && <p role="alert">{t.sistrixError(o.error)}</p>}
      {o && !o.error && !o.latest && <p>{t.sistrixNoData}</p>}
      {o?.latest && (
        <div className={styles.sxBody}>
          <span className={styles.sxValue}>{num(o.latest.value)}</span>
          {o.changePct != null && <span className={`${styles.sxChange} ${o.changePct < 0 ? styles.sxDown : styles.sxUp}`}>{o.changePct > 0 ? '+' : ''}{String(o.changePct).replace('.', ',')} % <small>{t.sistrixChange(Math.max(values.length - 1, 1))}</small></span>}
          <Spark values={values} />
          <small className={styles.sxDate}>{o.latest.date}</small>
        </div>
      )}
    </section>
  );
}
