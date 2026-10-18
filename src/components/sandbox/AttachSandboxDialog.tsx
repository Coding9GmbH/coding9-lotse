'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { CodeTaskPublic, GithubBranch, GithubRepo, RepoOwner, RepoProbe } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { PLUGIN_NAME, REPO_NAME, SANDBOX_DOCS } from '@/lib/sandbox-task';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { DumpUpload } from './DumpUpload';
import { Term } from './Term';
import styles from './Sandbox.module.css';

/** "Sandbox starten" in a chat: repository and base branch (preselected from the environment's presets or the AI's proposal),
 *  an optional title (the AI's reason when it proposed the sandbox) and, behind a disclosure, a dump. An empty repository (README,
 *  LICENSE, .gitignore at most) becomes a new plugin: the dialog then asks for its technical name (suggested from the repository name
 *  or the AI's proposal). No project yet: "Neues Projekt anlegen" creates a private repository with the stored token (owner = the token's user
 *  or one of its organisations) and selects it, so it continues as a new plugin. Creating attaches the sandbox to `chatId` and starts its
 *  setup. With Docker unreachable the dialog says so and cannot start. Plain words first ("Projekt"), the technical term small. */
export function AttachSandboxDialog({ open, onClose, chatId, initial, onCreated, dockerDown = false }: {
  open: boolean; onClose: () => void; chatId: string; initial?: { repo: string; baseBranch: string; title?: string; pluginName?: string } | null; onCreated: (task: CodeTaskPublic) => void; dockerDown?: boolean;
}) {
  const { t: all, locale } = useI18n();
  const t = all.sandbox.create;
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [branches, setBranches] = useState<GithubBranch[] | null>(null);
  const [form, setForm] = useState({ repo: '', baseBranch: '', title: '' });
  const [want, setWant] = useState<string>(''); // preferred base branch once the branches are known
  const [busy, setBusy] = useState(false);
  const [dumpId, setDumpId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Neues Projekt anlegen": null = closed; owners load when it opens
  const [newRepo, setNewRepo] = useState<{ owner: string; name: string } | null>(null);
  const [owners, setOwners] = useState<RepoOwner[] | null>(null);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [repoNote, setRepoNote] = useState<string | null>(null);
  // is repo@branch still empty? (key = the pair it was asked for, so an answer for an older choice is ignored)
  const [probe, setProbe] = useState<(RepoProbe & { key: string }) | null>(null);
  // the new plugin's name and the repo@branch the user typed it for ('' = preset): only a typed name survives a new probe
  const [name, setName] = useState({ value: '', editedFor: '' });
  const pluginName = name.value;
  // the dialog stays mounted: a new opening (or another AI offer) starts from its own preset, not from the last one's name and title
  const [shown, setShown] = useState({ open, initial });
  if (shown.open !== open || shown.initial !== initial) {
    setShown({ open, initial });
    if (open) { setName({ value: '', editedFor: '' }); setForm(f => ({ ...f, title: initial?.title?.slice(0, 120) ?? '' })); setNewRepo(null); setRepoNote(null); }
  }
  const probeKey = form.repo && form.baseBranch ? `${form.repo}@${form.baseBranch}` : '';
  const repoNameOk = !!newRepo && REPO_NAME.test(newRepo.name.trim());

  function openNewRepo() {
    setNewRepo({ owner: owners?.[0]?.login ?? '', name: '' }); setRepoNote(null); setError(null);
    if (owners) return;
    api.sandbox.repoOwners().then(r => { setOwners(r.owners); setNewRepo(n => (n && !n.owner ? { ...n, owner: r.owners[0]?.login ?? '' } : n)); }, e => { setOwners([]); setError(t.repoFailed(errorText(e))); });
  }
  async function createRepo() {
    if (!newRepo || !repoNameOk || !newRepo.owner) return;
    setCreatingRepo(true); setError(null);
    try {
      const { repo } = await api.sandbox.createRepo({ owner: newRepo.owner, name: newRepo.name.trim() });
      setRepos(list => [repo, ...(list ?? []).filter(r => r.fullName !== repo.fullName)]);
      setBranches(null); setWant(repo.defaultBranch); setForm(f => ({ ...f, repo: repo.fullName, baseBranch: '' }));
      setNewRepo(null); setRepoNote(t.repoCreated(repo.fullName));
    } catch (e) { setError(t.repoFailed(errorText(e))); }
    finally { setCreatingRepo(false); }
  }

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

  useEffect(() => {
    if (!open || !probeKey) return;
    let live = true;
    api.sandbox.repoProbe(form.repo, form.baseBranch).then(r => {
      if (!live) return;
      setProbe({ ...r, key: probeKey });
      // the AI's name belongs to the repository it proposed; elsewhere the suggestion from the repository name
      const preset = (initial?.repo === form.repo && initial.pluginName) || r.suggestedName;
      if (r.empty) setName(n => (n.editedFor === probeKey ? n : { value: preset, editedFor: '' }));
    }, () => { if (live) setProbe({ empty: null, suggestedName: '', key: probeKey }); });
    return () => { live = false; };
  }, [probeKey, open, initial]); // eslint-disable-line react-hooks/exhaustive-deps -- repo and branch are in the key
  const probed = probe?.key === probeKey ? probe : null;
  const newPlugin = probed?.empty === true;
  const nameOk = PLUGIN_NAME.test(pluginName.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { task } = await api.sandbox.createTask({ chatId, repo: form.repo, baseBranch: form.baseBranch, ...(form.title.trim() ? { title: form.title.trim() } : {}), ...(dumpId ? { dumpId } : {}), ...(newPlugin ? { pluginName: pluginName.trim() } : {}) });
      onCreated(task);
      onClose();
    } catch (err) { setError(t.failed(errorText(err))); }
    finally { setBusy(false); }
  }
  const ready = form.repo && form.baseBranch && probed && (!newPlugin || nameOk) && !busy && !uploading && !dockerDown && !newRepo && !creatingRepo;

  return (
    <Dialog open={open} onClose={onClose} title={t.title} wide footer={
      <>
        <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
        <Button variant="primary" type="submit" form="sbx-attach" busy={busy} disabled={!ready}>{busy ? t.submitting : t.submit}</Button>
      </>
    }>
      <form id="sbx-attach" className={styles.form} onSubmit={e => void submit(e)}>
        {dockerDown && <p className={styles.alert} role="alert">{t.dockerDown} <a href={SANDBOX_DOCS[locale]} target="_blank" rel="noreferrer">{t.guide}</a></p>}
        <p className={styles.hint}>{t.lead}</p>
        <label className={styles.field}>
          <span className={styles.label}><Term tech={t.repoTech}>{t.repo}</Term></span>
          <select value={form.repo} disabled={!repos?.length || !!newRepo} onChange={e => { setBranches(null); setWant(''); setRepoNote(null); setForm(f => ({ ...f, repo: e.target.value, baseBranch: '' })); }}>
            <option value="">{repos ? t.repoPick : t.reposLoading}</option>
            {repos?.map(r => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.push ? '' : ` (${t.readOnly})`}</option>)}
          </select>
        </label>
        {repoNote && <p className={styles.okBox} role="status">{repoNote}</p>}
        {!newRepo && repos && <p className={styles.fieldNote}><button type="button" className={styles.textBtn} onClick={openNewRepo} title={t.newRepoTitle}>{t.newRepo}</button></p>}
        {newRepo && (
          <div className={styles.newRepo} role="group" aria-labelledby="sbx-new-repo-h">
            <p id="sbx-new-repo-h" className={styles.label}>{t.newRepo}</p>
            <p className={styles.fieldHint}>{t.newRepoLead} {t.newRepoPermission}</p>
            <div className={styles.newRepoRow}>
              <label className={styles.field}>
                <span className={styles.label}>{t.owner}</span>
                <select value={newRepo.owner} disabled={!owners?.length || creatingRepo} onChange={e => setNewRepo(n => n && { ...n, owner: e.target.value })}>
                  {!owners && <option value="">{t.ownersLoading}</option>}
                  {owners?.map(o => <option key={o.login} value={o.login}>{o.login} ({o.kind === 'user' ? t.ownerUser : t.ownerOrg})</option>)}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>{t.repoName}</span>
                <input value={newRepo.name} maxLength={100} placeholder={t.repoNamePlaceholder} spellCheck={false} autoComplete="off" disabled={creatingRepo}
                  aria-invalid={!!newRepo.name && !repoNameOk} aria-describedby="sbx-repo-hint"
                  onChange={e => setNewRepo(n => n && { ...n, name: e.target.value.replace(/\s+/g, '-') })}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void createRepo(); } }} />
              </label>
            </div>
            <span id="sbx-repo-hint" className={`${styles.fieldNote} ${newRepo.name && !repoNameOk ? styles.fieldBad : ''}`}>{newRepo.name && !repoNameOk ? t.repoNameInvalid : t.repoNameHint}</span>
            <div className={styles.footRow}>
              <Button size="sm" variant="primary" onClick={() => void createRepo()} busy={creatingRepo} disabled={!repoNameOk || !newRepo.owner || creatingRepo}>{creatingRepo ? t.repoCreating : t.repoCreate}</Button>
              <Button size="sm" variant="ghost" onClick={() => setNewRepo(null)} disabled={creatingRepo}>{t.repoBack}</Button>
            </div>
          </div>
        )}
        <label className={styles.field}>
          <span className={styles.label}><Term tech={t.branchTech}>{t.branch}</Term></span>
          <select value={form.baseBranch} disabled={!branches?.length} onChange={e => setForm(f => ({ ...f, baseBranch: e.target.value }))}>
            {!branches && <option value="">{form.repo ? t.branchesLoading : '–'}</option>}
            {branches?.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </label>
        {newPlugin && (
          <div className={`${styles.field} ${styles.newPlugin}`}>
            <p className={styles.newPluginNote} role="status">{t.emptyRepo}</p>
            <label className={styles.label} htmlFor="sbx-plugin-name">{t.pluginName}</label>
            <input id="sbx-plugin-name" value={pluginName} maxLength={61} placeholder="CoNineHeaderBanner" spellCheck={false} autoComplete="off"
              aria-invalid={!!pluginName && !nameOk} aria-describedby="sbx-plugin-hint" onChange={e => setName({ value: e.target.value.replace(/\s+/g, ''), editedFor: probeKey })} />
            <span id="sbx-plugin-hint" className={`${styles.fieldNote} ${pluginName && !nameOk ? styles.fieldBad : ''}`}>{pluginName && !nameOk ? t.pluginInvalid : t.pluginHint}</span>
          </div>
        )}
        <label className={styles.field}>
          <span className={styles.label}>{t.name}</span>
          <input value={form.title} maxLength={120} placeholder={t.namePlaceholder} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
        </label>
        <details className={styles.dumpMore}>
          <summary>{all.sandbox.dump.add}</summary>
          <DumpUpload onChange={d => setDumpId(d?.id ?? null)} onBusy={setUploading} disabled={busy} />
        </details>
        {repos && !repos.length && !error && <p className={styles.alert}>{t.noGithub}</p>}
        {error && <p className={styles.bad} role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
