'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { CheckListItem } from '@/lib/custom-checks';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { useT } from '@/lib/i18n/I18nProvider';
import styles from './CheckManager.module.css';

interface Props { open: boolean; onClose: () => void; onChanged: () => void; onNew: () => void }

/** Prüfungen des Shop-Checks verwalten: an/aus, eigene löschen. Neue eigene Prüfungen entstehen im Chat. */
export function CheckManager({ open, onClose, onChanged, onNew }: Props) {
  const m = useT(), t = m.chat.checks;
  const [list, setList] = useState<CheckListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (open) api.checks.list().then(l => { setList(l); setErr(null); }, e => setErr(errorText(e))); }, [open]);

  const run = async (id: string, fn: () => Promise<void>) => { setBusy(id); setErr(null); try { await fn(); onChanged(); } catch (e) { setErr(errorText(e)); } finally { setBusy(null); } };
  const toggle = (c: CheckListItem) => run(c.id, async () => { await api.checks.setEnabled(c.id, !c.enabled); setList(l => l?.map(x => (x.id === c.id ? { ...x, enabled: !c.enabled } : x)) ?? null); });
  const remove = (c: CheckListItem) => run(c.id, async () => { await api.checks.remove(c.id); setList(l => l?.filter(x => x.id !== c.id) ?? null); });

  const areas = [...new Set((list ?? []).map(c => c.area))];
  const off = (list ?? []).filter(c => !c.enabled).length;
  return (
    <Dialog open={open} onClose={onClose} title={t.title} wide
      footer={<><Button onClick={() => { onClose(); onNew(); }}>{t.newInChat}</Button><Button variant="primary" onClick={onClose}>{t.done}</Button></>}>
      <p className={styles.lead}>{t.lead}{off > 0 && <> {t.offCount(off)}</>}</p>
      {err && <p className={styles.err} role="alert">{err}</p>}
      {!list && !err && <p className={styles.muted}>{t.loading}</p>}
      {areas.map(area => (
        <section key={area} className={styles.group}>
          <h3>{area}</h3>
          <ul>
            {list!.filter(c => c.area === area).map(c => (
              <li key={c.id} className={c.enabled ? undefined : styles.off}>
                <label>
                  <input type="checkbox" role="switch" checked={c.enabled} disabled={busy === c.id} onChange={() => void toggle(c)} />
                  <span className={styles.text}>
                    <b>{c.title}</b>{c.custom && <em>{t.custom}</em>}
                    {c.rule && <small>{c.rule}</small>}
                  </span>
                </label>
                {c.custom && <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => void remove(c)} aria-label={t.deleteAria(c.title)}>{m.common.delete}</Button>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Dialog>
  );
}
