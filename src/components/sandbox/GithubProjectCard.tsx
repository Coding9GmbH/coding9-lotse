'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { CodeTaskPublic, RepoOwner } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { REPO_NAME } from '@/lib/sandbox-task';
import { Button } from '@/components/ui/Button';
import styles from './Sandbox.module.css';

const slug = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** "Freigabe" tab of a sandbox started without a project: "Als GitHub-Projekt anlegen" – account and name (suggested from the plugin or
 *  the title), then Lotse creates a private repository and uploads the starting point; the tab becomes the usual "Zur Prüfung freigeben". */
export function GithubProjectCard({ task, onCreated }: { task: CodeTaskPublic; onCreated: (t: CodeTaskPublic) => void }) {
  const { t: all } = useI18n();
  const t = all.sandbox.ghProject, tc = all.sandbox.create;
  const [owners, setOwners] = useState<RepoOwner[] | null>(null);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState(slug(task.pluginName ?? task.title) || 'sandbox-plugin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.sandbox.repoOwners().then(r => { if (live) { setOwners(r.owners); setOwner(o => o || r.owners[0]?.login || ''); } }, e => { if (live) { setOwners([]); setError(t.failed(errorText(e))); } });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per tab
  const nameOk = REPO_NAME.test(name.trim());
  async function create() {
    setBusy(true); setError(null);
    try { onCreated((await api.sandbox.githubProject(task.id, { owner, name: name.trim() })).task); }
    catch (e) { setError(t.failed(errorText(e))); }
    finally { setBusy(false); }
  }
  return (
    <section className={styles.newRepo} aria-labelledby="sbx-gh-project">
      <h3 id="sbx-gh-project" className={styles.label}>{t.heading}</h3>
      <p className={styles.fieldHint}>{t.lead} {tc.newRepoPermission}</p>
      <div className={styles.newRepoRow}>
        <label className={styles.field}>
          <span className={styles.label}>{tc.owner}</span>
          <select value={owner} disabled={!owners?.length || busy} onChange={e => setOwner(e.target.value)}>
            {!owners && <option value="">{tc.ownersLoading}</option>}
            {owners?.map(o => <option key={o.login} value={o.login}>{o.login} ({o.kind === 'user' ? tc.ownerUser : tc.ownerOrg})</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{tc.repoName}</span>
          <input value={name} maxLength={100} spellCheck={false} autoComplete="off" disabled={busy} aria-invalid={!nameOk} onChange={e => setName(e.target.value.replace(/\s+/g, '-'))} />
        </label>
      </div>
      {!nameOk && <span className={`${styles.fieldNote} ${styles.fieldBad}`}>{tc.repoNameInvalid}</span>}
      <div className={styles.footRow}>
        <Button size="sm" variant="primary" onClick={() => void create()} busy={busy} disabled={!nameOk || !owner || busy}>{busy ? t.creating : t.create}</Button>
      </div>
      {error && <p className={styles.bad} role="alert">{error}</p>}
    </section>
  );
}
