'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { GithubBranch, GithubRepo } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import styles from './Sandbox.module.css';

/** Repository (from GitHub), base branch, title and goal; creating starts the setup and opens the task. */
export function NewTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useI18n().t.sandbox.create;
  const router = useRouter();
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [branches, setBranches] = useState<GithubBranch[] | null>(null);
  const [form, setForm] = useState({ repo: '', baseBranch: '', title: '', goal: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || repos) return;
    api.github.repos().then(r => setRepos(r.repos)).catch(e => { setRepos([]); setError(errorText(e)); });
  }, [open, repos]);
  useEffect(() => {
    if (!form.repo) return;
    let live = true;
    api.github.branches(form.repo).then(r => {
      if (!live) return;
      setBranches(r.branches);
      const def = repos?.find(x => x.fullName === form.repo)?.defaultBranch;
      setForm(f => ({ ...f, baseBranch: r.branches.some(b => b.name === def) ? def! : r.branches[0]?.name ?? '' }));
    }).catch(e => { if (live) { setBranches([]); setError(errorText(e)); } });
    return () => { live = false; };
  }, [form.repo, repos]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { task } = await api.sandbox.createTask(form);
      onClose();
      router.push(`/sandbox-coding/${task.id}`);
    } catch (err) { setError(t.failed(errorText(err))); }
    finally { setBusy(false); }
  }
  const ready = form.repo && form.baseBranch && form.title.trim() && !busy;

  return (
    <Dialog open={open} onClose={onClose} title={t.title} wide footer={
      <>
        <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
        <Button variant="primary" type="submit" form="sbx-new-task" busy={busy} disabled={!ready}>{busy ? t.submitting : t.submit}</Button>
      </>
    }>
      <form id="sbx-new-task" className={styles.form} onSubmit={e => void submit(e)}>
        <p className={styles.hint}>{t.lead}</p>
        <label className={styles.field}>
          <span className={styles.label}>{t.repo}</span>
          <select value={form.repo} disabled={!repos?.length} onChange={e => { setBranches(null); setForm(f => ({ ...f, repo: e.target.value, baseBranch: '' })); }}>
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
        <label className={styles.field}>
          <span className={styles.label}>{t.goal}</span>
          <textarea value={form.goal} rows={4} maxLength={4000} placeholder={t.goalPlaceholder} onChange={e => setForm(f => ({ ...f, goal: e.target.value }))} />
        </label>
        {repos && !repos.length && !error && <p className={styles.alert}>{t.noGithub}</p>}
        {error && <p className={styles.bad} role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
