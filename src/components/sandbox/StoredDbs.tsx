'use client';

import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { LibraryDumpPublic } from '@/lib/protocol';
import { INTL_LOCALE } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import { IconPlus } from '@/components/ui/icons';
import { DumpUpload } from './DumpUpload';
import styles from './Sandbox.module.css';

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;

/** "Gespeicherte Datenbanken": name, Shopware version, size, uploaded at/by, last used and whether a quick-start snapshot exists for
 *  the configured image; upload (always stored) and delete (with confirmation: file and snapshots). The list comes from the page. */
export function StoredDbs({ dumps, error, onChanged }: { dumps: LibraryDumpPublic[] | null; error: string | null; onChanged: () => void }) {
  const { t: all, locale } = useI18n();
  const t = all.sandbox.library;
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const when = (iso: string) => new Date(iso).toLocaleString(INTL_LOCALE[locale], { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

  async function remove(d: LibraryDumpPublic) {
    if (!window.confirm(t.removeConfirm(d.name))) return;
    setBusy(d.id); setNotice(null);
    try { await api.sandbox.deleteDump(d.id); setNotice({ ok: true, text: t.removed(d.name) }); onChanged(); }
    catch (e) { setNotice({ ok: false, text: t.failed(errorText(e)) }); }
    finally { setBusy(null); }
  }

  return (
    <section className={styles.card} aria-labelledby="sbx-dbs">
      <div className={styles.cardHead}>
        <h2 id="sbx-dbs">{t.heading}</h2>
        {!adding && <Button size="sm" className={styles.headBtn} onClick={() => { setAdding(true); setNotice(null); }}><IconPlus size={14} /> {t.upload}</Button>}
      </div>
      <p className={styles.hint}>{t.lead}</p>
      {error && <p className={styles.alert} role="alert">{t.loadFailed(error)}</p>}
      {dumps && !dumps.length && !adding && <p className={styles.empty}>{t.empty}</p>}
      {!!dumps?.length && (
        <ul className={styles.dbList}>
          {dumps.map(d => (
            <li key={d.id} className={styles.dbRow}>
              <span className={styles.taskTitle}>{d.name}</span>
              <span className={styles.taskMeta}>
                {d.shopwareVersion ? t.version(d.shopwareVersion) : t.versionUnknown} · {mb(d.size)} · {t.uploaded(when(d.createdAt), d.uploadedBy)} · {d.lastUsedAt ? t.lastUsed(when(d.lastUsedAt)) : t.neverUsed}
              </span>
              <span className={styles.dbActions}>
                {d.snapshot
                  ? <span className={styles.badgeOk} title={t.quickTitle}>{t.quick}</span>
                  : <span className={styles.muted} title={t.quickLaterTitle}>{t.quickLater}</span>}
                <Button size="sm" variant="ghost" aria-label={t.removeLabel(d.name)} busy={busy === d.id} disabled={!!busy} onClick={() => void remove(d)}>{t.remove}</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div className={styles.dbUpload}>
          <DumpUpload storeOnly onBusy={setUploading} onChange={d => { if (d) onChanged(); }} />
          <Button size="sm" variant="ghost" disabled={uploading} onClick={() => setAdding(false)}>{t.uploadDone}</Button>
        </div>
      )}
      {notice && <p className={notice.ok ? styles.ok : styles.bad} role="status">{notice.text}</p>}
    </section>
  );
}
