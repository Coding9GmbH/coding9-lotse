'use client';

import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { Messages } from '@/lib/i18n';
import type { LibraryDumpPublic, QuickStartPublic, QuickStartSetup } from '@/lib/protocol';
import { savedText } from '@/lib/sandbox-task';
import { INTL_LOCALE } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import { IconPlus } from '@/components/ui/icons';
import { Menu } from '@/components/ui/Menu';
import { AttachSandboxDialog } from './AttachSandboxDialog';
import styles from './Sandbox.module.css';

/** What a quick start will use, in one line: "Bestehendes Projekt · acme/shop @ main · Demo-Daten · Image 6.7.14.0" */
export function quickSummary(s: QuickStartSetup, all: Messages, dumps: LibraryDumpPublic[] | null): string {
  const ts = all.sandbox.start;
  const source = s.kind === 'none' ? ts.localSource(s.pluginName || 'SandboxPlugin') : `${s.repo} @ ${s.baseBranch}`;
  const data = s.dumpId ? dumps?.find(d => d.id === s.dumpId)?.name ?? ts.dataStored : ts.dataDemo;
  const line = ts.summary(ts.kinds[s.kind].title, source, data);
  return s.image ? `${line} · ${all.sandbox.quick.image(s.image.slice(s.image.lastIndexOf(':') + 1))}` : line;
}

/** "Schnellstarts" on the Sandbox Coding page (A22): name, what it uses, default and last use; "Neuer Schnellstart" and per row
 *  Bearbeiten (the start dialog as its editor), Umbenennen, Duplizieren, Als Standard / Nicht mehr Standard, Löschen. */
export function QuickStarts({ list, dumps, error, onChanged }: { list: QuickStartPublic[] | null; dumps: LibraryDumpPublic[] | null; error: string | null; onChanged: () => void }) {
  const { t: all, locale } = useI18n();
  const t = all.sandbox.quick;
  // the dialog's props are kept as they were when it opened (a new object would start it over)
  const [editing, setEditing] = useState<{ editing: { id: string | null; name: string }; quick: { id: string; name: string; setup: QuickStartSetup } | null } | null>(null);
  const edit = (q: QuickStartPublic | null) => { setEditing({ editing: { id: q?.id ?? null, name: q?.name ?? '' }, quick: q ? { id: q.id, name: q.name, setup: q.setup } : null }); setNotice(null); };
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const when = (iso: string) => new Date(iso).toLocaleString(INTL_LOCALE[locale], { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

  async function run(id: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(id); setNotice(null);
    try { await fn(); if (ok) setNotice({ ok: true, text: ok }); onChanged(); return true; }
    catch (e) { setNotice({ ok: false, text: t.failed(errorText(e)) }); return false; }
    finally { setBusy(null); }
  }
  const remove = (q: QuickStartPublic) => { if (window.confirm(t.removeConfirm(q.name))) void run(q.id, () => api.sandbox.deleteQuickStart(q.id), t.removed(q.name)); };
  const rename = async () => {
    if (!renaming?.name.trim()) return;
    if (await run(renaming.id, () => api.sandbox.updateQuickStart(renaming.id, { name: renaming.name }))) setRenaming(null);
  };

  return (
    <section className={styles.card} aria-labelledby="sbx-quick" id="sbx-quick">
      <div className={styles.cardHead}>
        <h2 id="sbx-quick">{t.heading}</h2>
        <Button size="sm" className={styles.headBtn} onClick={() => edit(null)}><IconPlus size={14} /> {t.add}</Button>
      </div>
      <p className={styles.hint}>{t.lead}</p>
      {error && <p className={styles.alert} role="alert">{t.loadFailed(error)}</p>}
      {list && !list.length && <p className={styles.empty}>{t.empty}</p>}
      {!!list?.length && (
        <ul className={styles.dbList}>
          {list.map(q => (
            <li key={q.id} className={styles.dbRow}>
              {renaming?.id === q.id
                ? <span className={`${styles.taskTitle} ${styles.qsRename}`}>
                  <input aria-label={t.renameLabel(q.name)} value={renaming.name} maxLength={80} autoFocus onChange={e => setRenaming({ id: q.id, name: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void rename(); } if (e.key === 'Escape') setRenaming(null); }} />
                  <Button size="sm" variant="primary" busy={busy === q.id} disabled={!renaming.name.trim()} onClick={() => void rename()}>{t.renameSave}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>{t.cancel}</Button>
                </span>
                : <span className={styles.taskTitle}>{q.name}</span>}
              <span className={styles.taskMeta}>{quickSummary(q.setup, all, dumps)} · {q.lastUsedAt ? t.lastUsed(when(q.lastUsedAt)) : t.neverUsed}</span>
              <span className={styles.dbActions}>
                {q.default && <span className={styles.badgeOk} title={t.defaultTitle}>{t.isDefault}</span>}
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => edit(q)}>{t.edit}</Button>
                <Menu label={t.actions(q.name)} items={[
                  { key: 'rename', label: t.rename, onSelect: () => setRenaming({ id: q.id, name: q.name }), disabled: !!busy },
                  { key: 'dup', label: t.duplicate, onSelect: () => void run(q.id, () => api.sandbox.createQuickStart({ duplicateOf: q.id })), disabled: !!busy },
                  { key: 'default', label: q.default ? t.unsetDefault : t.makeDefault, onSelect: () => void run(q.id, () => api.sandbox.updateQuickStart(q.id, { isDefault: !q.default })), disabled: !!busy },
                  { key: 'remove', label: t.remove, onSelect: () => remove(q), disabled: !!busy, danger: true },
                ]} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {notice && <p className={notice.ok ? styles.ok : styles.bad} role="status">{notice.text}</p>}
      <AttachSandboxDialog open={!!editing} onClose={() => setEditing(null)} editing={editing?.editing ?? null} quick={editing?.quick ?? null} onSaved={q => { onChanged(); setNotice({ ok: true, text: savedText(q, all) }); }} />
    </section>
  );
}
