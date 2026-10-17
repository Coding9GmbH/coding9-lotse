'use client';

import { useEffect, useRef, useState } from 'react';
import { api, errorText, uploadDumpChunked } from '@/lib/api';
import type { DumpPublic } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import styles from './Sandbox.module.css';

type Phase = 'idle' | 'uploading' | 'paused' | 'ready' | 'error';
const ACCEPT = /\.sql(\.gz)?$/i;

/** Optional database dump: drag & drop or file picker, chunked upload with progress, cancel and resume. onChange gets the complete dump. */
export function DumpUpload({ onChange, onBusy, disabled }: { onChange: (dump: DumpPublic | null) => void; onBusy?: (busy: boolean) => void; disabled?: boolean }) {
  const t = useI18n().t.sandbox.dump;
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState({ received: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const idRef = useRef<string | null>(null);
  const acRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { onBusy?.(phase === 'uploading' || phase === 'paused'); }, [phase, onBusy]);

  async function upload(f: File) {
    const ac = new AbortController();
    acRef.current = ac;
    setPhase('uploading'); setError(null);
    try {
      const dump = await uploadDumpChunked(f, {
        resumeId: idRef.current, signal: ac.signal,
        onStart: id => { idRef.current = id; },
        onProgress: (received, total) => setProgress({ received, total }),
      });
      if (acRef.current !== ac) return; // replaced or removed meanwhile
      setPhase('ready');
      onChange(dump);
    } catch (e) {
      if (acRef.current !== ac) return;
      if (ac.signal.aborted) { setPhase('paused'); return; }
      setPhase('error'); setError(errorText(e));
    }
  }
  function pick(f: File | undefined) {
    if (!f || disabled) return;
    if (!ACCEPT.test(f.name)) { setPhase('error'); setError(t.wrongType); return; }
    void discard();
    setFile(f); setProgress({ received: 0, total: f.size });
    void upload(f);
  }
  async function discard() {
    acRef.current?.abort();
    acRef.current = null;
    const id = idRef.current;
    idRef.current = null;
    onChange(null);
    if (id) await api.sandbox.deleteDump(id).catch(() => {});
  }
  function reset() { void discard(); setFile(null); setPhase('idle'); setError(null); if (inputRef.current) inputRef.current.value = ''; }

  const pct = progress.total ? Math.floor((progress.received / progress.total) * 100) : 0;
  return (
    <div className={styles.field}>
      <span className={styles.label}>{t.heading}</span>
      <p className={styles.fieldHint}>{t.hint}</p>
      {phase === 'idle' || (phase === 'error' && !file) ? (
        <div className={styles.drop} data-over={over || undefined}
          onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}>
          <span>{t.drop}</span>
          <Button size="sm" onClick={() => inputRef.current?.click()} disabled={disabled}>{t.choose}</Button>
          <input ref={inputRef} type="file" accept=".sql,.gz,application/sql,application/gzip" hidden aria-label={t.heading} onChange={e => pick(e.target.files?.[0])} />
          <span className={styles.fieldHint}>{t.types}</span>
        </div>
      ) : (
        <div className={styles.dumpBox}>
          {phase === 'ready' ? <p className={styles.ok} role="status">✓ {t.ready(file?.name ?? '', file?.size ?? 0)}</p> : (
            <>
              <progress max={100} value={pct} aria-label={t.heading} />
              <p className={styles.muted} role="status">{phase === 'paused' ? t.paused : t.uploading(pct, progress.received, progress.total)}</p>
            </>
          )}
          <div className={styles.dumpActions}>
            {phase === 'uploading' && <Button size="sm" onClick={() => acRef.current?.abort()}>{t.cancel}</Button>}
            {(phase === 'paused' || phase === 'error') && file && <Button size="sm" variant="primary" onClick={() => void upload(file)} disabled={disabled}>{t.resume}</Button>}
            <Button size="sm" variant="ghost" onClick={reset} disabled={disabled}>{t.remove}</Button>
          </div>
        </div>
      )}
      {error && <p className={styles.bad} role="alert">{t.failed(error)}</p>}
    </div>
  );
}
