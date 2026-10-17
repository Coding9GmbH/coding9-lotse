'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { CodeTaskPublic, GithubBranch, GithubRepo } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { DumpUpload } from './DumpUpload';
import styles from './Sandbox.module.css';

/** "Sandbox starten" in a chat: repository and base branch (preselected from the environment's presets or the AI's proposal),
 *  an optional title and dump. Creating attaches the sandbox to `chatId` and starts its setup. */
export function AttachSandboxDialog({ open, onClose, chatId, initial, onCreated }: {
  open: boolean; onClose: () => void; chatId: string; initial?: { repo: string; baseBranch: string } | null; onCreated: (task: CodeTaskPublic) => void;
}) {
  const t = useI18n().t.sandbox.create;
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [branches, setBranches] = useState<GithubBranch[] | null>(null);
  const [form, setForm] = useState({ repo: '', baseBranch: '', title: '' });
  const [want, setWant] = useState<string>(''); // preferred base branch once the branches are known
  const [busy, setBusy] = useState(false);
  const [dumpId, setDumpId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On open: repositories and the preset (AI proposal first, then the environment's defaults)
  useEffect(() => {
    if (!open) return;
    let live = true;
    const pre = initial?.repo ? Promise.resolve({ repo: initial.repo, baseBranch: initial.baseBranch }) : api.sandbox.env().then(v => ({ repo: v.env.defaultRepo, baseBranch: v.env.defaultBranch }), () => ({ repo: '', baseBranch: '' }));
    Promise.all([repos ? Promise.resolve(repos) : api.github.repos().then(r => r.repos), pre]).then(([list, p]) => {
      if (!live) return;
      setRepos(list); setError(null);
      if (p.repo && list.some(r => r.fullName === p.repo)) { setBranches(null); setWant(p.baseBranch); setForm(f => ({ ...f, repo: p.repo, baseBranch: '' })); }
    }).catch(e => { if (live) { setRepos([]); setError(errorText(e)); } });
    return () => { live = false; };
  }, [open, initial]); // eslint-disable-line react-hooks/exhaustive-deps -- repos only as a cache
  useEffect(() => {
    if (!form.repo) return;
    let live = true;
    api.github.branches(form.repo).then(r => {
      if (!live) return;
      setBranches(r.branches);
      const def = repos?.find(x => x.fullName === form.repo)?.defaultBranch;
      const pick = [want, def].find(b => b && r.branches.some(x => x.name === b));
      setForm(f => ({ ...f, baseBranch: pick ?? r.branches[0]?.name ?? '' }));
    }).catch(e => { if (live) { setBranches([]); setError(errorText(e)); } });
    return () => { live = false; };
  }, [form.repo, repos, want]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { task } = await api.sandbox.createTask({ chatId, repo: form.repo, baseBranch: form.baseBranch, ...(form.title.trim() ? { title: form.title.trim() } : {}), ...(dumpId ? { dumpId } : {}) });
      onCreated(task);
      onClose();
    } catch (err) { setError(t.failed(errorText(err))); }
    finally { setBusy(false); }
  }
  const ready = form.repo && form.baseBranch && !busy && !uploading;

  return (
    <Dialog open={open} onClose={onClose} title={t.title} wide footer={
      <>
        <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
        <Button variant="primary" type="submit" form="sbx-attach" busy={busy} disabled={!ready}>{busy ? t.submitting : t.submit}</Button>
      </>
    }>
      <form id="sbx-attach" className={styles.form} onSubmit={e => void submit(e)}>
        <p className={styles.hint}>{t.lead}</p>
        <label className={styles.field}>
          <span className={styles.label}>{t.repo}</span>
          <select value={form.repo} disabled={!repos?.length} onChange={e => { setBranches(null); setWant(''); setForm(f => ({ ...f, repo: e.target.value, baseBranch: '' })); }}>
            <option value="">{repos ? t.repoPick : t.reposLoading}</option>
            {repos?.map(r => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.push ? '' : ` (${t.readOnly})`}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t.branch}</span>
          <select value={form.baseBranch} disabled={!branches?.length} onChange={e => setForm(f => ({ ...f, baseBranch: e.target.value }))}>
            {!branches && <option value="">{form.repo ? t.branchesLoading : '–'}</option>}
            {branches?.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t.name}</span>
          <input value={form.title} maxLength={120} placeholder={t.namePlaceholder} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
        </label>
        <DumpUpload onChange={d => setDumpId(d?.id ?? null)} onBusy={setUploading} disabled={busy} />
        {repos && !repos.length && !error && <p className={styles.alert}>{t.noGithub}</p>}
        {error && <p className={styles.bad} role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
