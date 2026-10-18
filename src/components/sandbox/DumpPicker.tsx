'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { LibraryDumpPublic } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { DumpUpload } from './DumpUpload';
import styles from './Sandbox.module.css';

const UPLOAD = 'upload';

/** The database of a sandbox: a stored database ("Gespeicherte Datenbanken"), none (Dockware's demo data, only where `allowNone`) or a
 *  new upload (stored for further sandboxes unless unticked). Without stored databases it is just the upload. `preset`: the
 *  environment's default stored database. onChange gets the chosen dump id (null = none or nothing chosen yet). */
export function DumpPicker({ onChange, onBusy, disabled, allowNone = true, preset = '' }: {
  onChange: (dumpId: string | null) => void; onBusy?: (busy: boolean) => void; disabled?: boolean; allowNone?: boolean; preset?: string;
}) {
  const t = useI18n().t.sandbox.dump;
  const [list, setList] = useState<LibraryDumpPublic[] | null>(null);
  const [choice, setChoice] = useState('');
  useEffect(() => {
    let live = true;
    api.sandbox.storedDbs().then(r => {
      if (!live) return;
      setList(r.dumps);
      if (preset && r.dumps.some(d => d.id === preset)) { setChoice(preset); onChange(preset); }
    }, () => { if (live) setList([]); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- loaded once per opening (the dialogs mount it when they open)

  if (!list) return null;
  if (!list.length && choice !== UPLOAD) {
    return <DumpUpload onChange={d => onChange(d?.id ?? null)} onBusy={onBusy} disabled={disabled} />;
  }
  const pick = (v: string) => { setChoice(v); onChange(v && v !== UPLOAD ? v : null); };
  return (
    <div className={styles.field}>
      <label className={styles.field}>
        <span className={styles.label}>{t.pick}</span>
        <select value={choice} disabled={disabled} aria-label={t.pick} aria-describedby="sbx-dump-pick-hint" onChange={e => pick(e.target.value)}>
          <option value="">{allowNone ? t.pickNone : t.pickChoose}</option>
          {list.map(d => <option key={d.id} value={d.id}>{t.pickOption(d.name, d.shopwareVersion, d.size, d.snapshot)}</option>)}
          <option value={UPLOAD}>{t.pickUpload}</option>
        </select>
      </label>
      <span id="sbx-dump-pick-hint" className={styles.fieldHint}>{t.pickHint}</span>
      {choice === UPLOAD && (
        <DumpUpload onBusy={onBusy} disabled={disabled} onChange={d => {
          if (!d) { onChange(null); return; }
          if (d.library) { // stored now: it becomes an entry of the list and stays chosen there
            setList(l => [{ id: d.id, name: d.name, size: d.size, shopwareVersion: null, createdAt: new Date().toISOString(), uploadedBy: null, lastUsedAt: null, snapshot: false }, ...(l ?? [])]);
            setChoice(d.id);
          }
          onChange(d.id);
        }} />
      )}
    </div>
  );
}
