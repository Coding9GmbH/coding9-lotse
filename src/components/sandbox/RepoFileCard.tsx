'use client';

import type { RepoFileInfo } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import styles from './Sandbox.module.css';

/** The commands a repository's .lotse/sandbox.json wants to run during the setup, shown before anything runs (start dialog, or the
 *  setup waiting at "Plugin erkennen"): label, phase and the exact command line, plus what else the file sets. Nothing runs without
 *  "Befehle erlauben"; "Ohne diese Befehle" starts without them. `state` after a decision replaces the buttons with a line. */
export function RepoFileCard({ file, missingEnv = [], state, busy, onApprove, onSkip }: {
  file: RepoFileInfo; missingEnv?: string[]; state: 'pending' | 'approved' | 'skipped'; busy?: boolean; onApprove: () => void; onSkip: () => void;
}) {
  const t = useI18n().t.sandbox.repoFile;
  const extra = [
    ...(file.image ? [t.image(file.image)] : []), ...(file.previewPath ? [t.preview(file.previewPath)] : []),
    ...(missingEnv.length ? [t.missingEnv(missingEnv.join(', '))] : []), ...(file.ignored.length ? [t.ignored(file.ignored.join(', '))] : []),
  ];
  return (
    <section className={styles.repoFile} aria-labelledby={`sbx-rf-${file.hash.slice(0, 8)}`}>
      {file.commands.length > 0 && <>
        <h3 id={`sbx-rf-${file.hash.slice(0, 8)}`} className={styles.label}>{t.heading}</h3>
        <p className={styles.fieldHint}>{t.lead}</p>
        <ol className={styles.repoCmds}>
          {file.commands.map((c, i) => (
            <li key={i}><b>{c.label}</b> <small className={styles.muted}>({t.phase[c.phase]})</small><pre>{c.command}</pre></li>
          ))}
        </ol>
      </>}
      {!file.commands.length && <h3 id={`sbx-rf-${file.hash.slice(0, 8)}`} className={styles.label}>{t.fileInfo}</h3>}
      {extra.length > 0 && <ul className={styles.repoExtra}>{extra.map(x => <li key={x}>{x}</li>)}</ul>}
      {file.commands.length > 0 && (state === 'pending'
        ? <div className={styles.footRow}>
          <Button size="sm" variant="primary" onClick={onApprove} busy={busy} disabled={busy}>{t.approve}</Button>
          <Button size="sm" variant="ghost" onClick={onSkip} disabled={busy}>{t.skip}</Button>
        </div>
        : <p className={state === 'approved' ? styles.okBox : styles.muted} role="status">{state === 'approved' ? t.approved : t.skipped}</p>)}
    </section>
  );
}
