'use client';

import type { FileChangeKind } from '@/lib/protocol';
import { useT } from '@/lib/i18n/I18nProvider';
import styles from './CodeCards.module.css';

/** A file the AI created, changed or deleted in the task's repository (already mirrored into the container). */
export function FileChangeCard({ path, kind, added, removed }: { path: string; kind: FileChangeKind; added: number; removed: number }) {
  const t = useT().sandbox.code;
  return (
    <div className={styles.file} role="group" aria-label={t.fileAria(t.file[kind], path, added, removed)}>
      <span className={`${styles.kind} ${kind === 'delete' ? styles.kind_delete : ''}`} aria-hidden="true">{t.file[kind]}</span>
      <span className={styles.path} aria-hidden="true">{path}</span>
      <span className={styles.delta} aria-hidden="true"><span className={styles.add}>+{added}</span><span className={styles.del}>−{removed}</span></span>
    </div>
  );
}
