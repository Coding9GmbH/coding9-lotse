'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { CodeTaskPublic, CommandPhase, GithubBranch, GithubRepo, LibraryDumpPublic, NewSandboxRequest, RepoOwner, RepoProbe } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { PLUGIN_NAME, REPO_NAME, SANDBOX_DOCS, pluginNameFromRepo, suggestTargetPath, targetPathProblem } from '@/lib/sandbox-task';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { DumpUpload } from './DumpUpload';
import { RepoFileCard } from './RepoFileCard';
import { Term } from './Term';
import styles from './Sandbox.module.css';

/** What the sandbox is for (step "Was?"): an existing project (detected), a new plugin, no project at all, or an own setup */
export type StartKind = 'existing' | 'new' | 'none' | 'custom';
type Data = 'demo' | 'stored' | 'upload';
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
const KINDS: StartKind[] = ['existing', 'new', 'none', 'custom'];

/**
 * "Sandbox starten" in a chat, in three short steps with defaults (A20):
 *  1. Was? – existing project (default), new plugin, without a project, own setup; an optional title.
 *  2. Code-Quelle – project and starting point (presets: the AI's proposal, else the environment's); before the start Lotse checks
 *     repo@branch and shows what it found as a chip with "ändern" (as detected, or an own setup); a .lotse/sandbox.json with commands
 *     shows them with "Befehle erlauben" / "Ohne diese Befehle". A new plugin: an empty project or "Neues Projekt anlegen", plus its
 *     technical name. Without a project: only the plugin's name. "Erweitert" (folded; open for an own setup): target folder, own
 *     commands and variables of this sandbox.
 *  3. Daten – demo data (default), a stored database (the environment's default preselected) or a dump upload.
 * Plain words first, the technical term small. Errors say what to do next. Creating attaches the sandbox to `chatId` and starts it.
 */
export function AttachSandboxDialog({ open, onClose, chatId, initial, onCreated, dockerDown = false }: {
  open: boolean; onClose: () => void; chatId: string; initial?: { repo: string; baseBranch: string; title?: string; pluginName?: string } | null; onCreated: (task: CodeTaskPublic) => void; dockerDown?: boolean;
}) {
  const { t: all, locale } = useI18n();
  const t = all.sandbox.create, ts = all.sandbox.start;
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<StartKind>('existing');
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [branches, setBranches] = useState<GithubBranch[] | null>(null);
  const [form, setForm] = useState({ repo: '', baseBranch: '', title: '' });
  const [want, setWant] = useState<string>(''); // preferred base branch once the branches are known
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Neues Projekt anlegen": null = closed; owners load when it opens
  const [newRepo, setNewRepo] = useState<{ owner: string; name: string } | null>(null);
  const [owners, setOwners] = useState<RepoOwner[] | null>(null);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [repoNote, setRepoNote] = useState<string | null>(null);
  // what repo@branch is (key = the pair it was asked for, so an answer for an older choice is ignored)
  const [probe, setProbe] = useState<(RepoProbe & { key: string }) | null>(null);
  // the new plugin's name and the repo@branch the user typed it for ('' = preset): only a typed name survives a new probe
  const [name, setName] = useState({ value: '', editedFor: '' });
  // "ändern": as detected, or an own setup
  const [modeOpen, setModeOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [target, setTarget] = useState({ value: '', edited: false });
  const [commands, setCommands] = useState<{ label: string; command: string; phase: CommandPhase }[]>([]);
  const [vars, setVars] = useState<{ key: string; value: string }[]>([]);
  const [advanced, setAdvanced] = useState(false);
  // the repository file's commands: approved (server), declined for this sandbox (hash), deciding
  const [skipHash, setSkipHash] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  // step 3
  const [data, setData] = useState<Data>('demo');
  const [stored, setStored] = useState<LibraryDumpPublic[] | null>(null);
  const [storedId, setStoredId] = useState('');
  const [uploadId, setUploadId] = useState<string | null>(null);
  // the dialog stays mounted: a new opening (or another AI offer) starts from its own preset
  const [shown, setShown] = useState({ open, initial });
  if (shown.open !== open || shown.initial !== initial) {
    setShown({ open, initial });
    if (open) {
      setStep(initial?.repo ? 1 : 0); setKind('existing'); setName({ value: '', editedFor: '' }); setForm(f => ({ ...f, title: initial?.title?.slice(0, 120) ?? '' }));
      setNewRepo(null); setRepoNote(null); setError(null); setModeOpen(false); setCustom(false); setTarget({ value: '', edited: false }); setCommands([]); setVars([]); setAdvanced(false);
      setSkipHash(null); setData('demo'); setStoredId(''); setUploadId(null); setStored(null);
    }
  }
  const usesRepo = kind !== 'none';
  const probeKey = usesRepo && form.repo && form.baseBranch ? `${form.repo}@${form.baseBranch}` : '';
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

  // On open: repositories, the stored databases and the presets (AI proposal first, then the environment's defaults)
  useEffect(() => {
    if (!open) return;
    let live = true;
    const env = api.sandbox.env().then(v => v.env, () => null);
    void Promise.all([env, api.sandbox.storedDbs().then(r => r.dumps, () => [] as LibraryDumpPublic[])]).then(([v, dumps]) => {
      if (!live) return;
      setStored(dumps);
      const preset = v?.defaultDumpId && dumps.some(d => d.id === v.defaultDumpId) ? v.defaultDumpId : '';
      if (preset) { setStoredId(preset); setData('stored'); } else if (dumps[0]) setStoredId(dumps[0].id);
    });
    const pre = initial?.repo ? Promise.resolve({ repo: initial.repo, baseBranch: initial.baseBranch }) : env.then(v => ({ repo: v?.defaultRepo ?? '', baseBranch: v?.defaultBranch ?? '' }));
    Promise.all([repos ? Promise.resolve(repos) : api.github.repos().then(r => r.repos), pre]).then(([list, p]) => {
      if (!live) return;
      setRepos(list);
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
    }, () => { if (live) setProbe({ empty: null, suggestedName: '', detected: null, repoFile: null, key: probeKey }); });
    return () => { live = false; };
  }, [probeKey, open, initial]); // eslint-disable-line react-hooks/exhaustive-deps -- repo and branch are in the key

  const probed = probe?.key === probeKey ? probe : null;
  const detected = probed?.detected ?? null;
  const file = probed?.repoFile && !('error' in probed.repoFile) ? probed.repoFile : null;
  const fileError = probed?.repoFile && 'error' in probed.repoFile ? probed.repoFile.error : null;
  // an own setup: chosen in step 1, by "ändern", by the repository file, or forced because Lotse does not know the layout
  const ownSetup = kind === 'custom' || (kind === 'existing' && (custom || file?.mode === 'custom' || detected?.kind === 'unknown'));
  const newPlugin = kind === 'none' || (kind !== 'custom' && !ownSetup && probed?.empty === true);
  // a typed target survives; otherwise the repository file's or /opt/<name>
  const targetValue = target.edited ? target.value : file?.targetPath ?? suggestTargetPath(form.repo);
  const targetBad = ownSetup ? targetPathProblem(targetValue) : null;
  const pluginName = kind === 'none' ? (name.editedFor === 'none' ? name.value : pluginNameFromRepo(form.title) || 'SandboxPlugin') : name.value;
  const nameOk = PLUGIN_NAME.test(pluginName.trim());
  const fileState: 'pending' | 'approved' | 'skipped' = !file?.commands.length ? 'approved' : file.approved ? 'approved' : skipHash === file.hash ? 'skipped' : 'pending';
  const varsOk = vars.every(v => ENV_KEY.test(v.key.trim()));
  const commandsOk = commands.every(c => c.label.trim() && c.command.trim());

  const stepOk = [
    true,
    kind === 'none' ? nameOk
      : !!form.repo && !!form.baseBranch && !!probed && !newRepo && !creatingRepo && !fileError && fileState !== 'pending'
        && (kind !== 'new' || probed.empty === true) && (!newPlugin || nameOk) && !targetBad && varsOk && commandsOk,
    data === 'demo' || (data === 'stored' && !!storedId) || (data === 'upload' && !!uploadId && !uploading),
  ];
  const canGo = (i: number) => stepOk.slice(0, i).every(Boolean);

  async function decide(approve: boolean) {
    if (!file) return;
    if (!approve) { setSkipHash(file.hash); return; }
    setDeciding(true); setError(null);
    try { const r = await api.sandbox.approveRepoFile(form.repo, form.baseBranch, file.hash); setProbe({ ...r, key: probeKey }); }
    catch (e) { setError(all.sandbox.repoFile.approveFailed(errorText(e))); }
    finally { setDeciding(false); }
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (step < 2) { if (stepOk[step]) setStep(step + 1); return; }
    if (!stepOk.every(Boolean)) return;
    setBusy(true); setError(null);
    const dumpId = data === 'stored' ? storedId : data === 'upload' ? uploadId : null;
    const req: NewSandboxRequest = {
      chatId, repo: usesRepo ? form.repo : '', baseBranch: usesRepo ? form.baseBranch : '',
      ...(form.title.trim() ? { title: form.title.trim() } : {}), ...(dumpId ? { dumpId } : {}), ...(newPlugin ? { pluginName: pluginName.trim() } : {}),
      ...(kind === 'none' ? { source: 'none' as const } : {}),
      ...(ownSetup ? { mode: 'custom' as const, targetPath: targetValue } : {}),
      ...(commands.length ? { commands: commands.map(c => ({ label: c.label.trim(), command: c.command.trim(), phase: c.phase })) } : {}),
      ...(vars.length ? { env: vars.map(v => ({ key: v.key.trim(), value: v.value })) } : {}),
      ...(file && fileState === 'skipped' ? { skipRepoHash: file.hash } : {}),
    };
    try {
      const { task } = await api.sandbox.createTask(req);
      onCreated(task);
      onClose();
    } catch (err) { setError(t.failed(errorText(err))); }
    finally { setBusy(false); }
  }

  const detectedText = (): string => {
    if (!detected) return '';
    const d = ts.detected;
    return detected.kind === 'plugin' ? d.plugin(detected.name ?? '') : detected.kind === 'theme' ? d.theme(detected.name ?? '')
      : detected.kind === 'project' ? d.project(detected.plugins ?? 0) : detected.kind === 'new' ? d.new : d.unknown;
  };
  const ready = !busy && !uploading && !dockerDown;
  const last = step === 2;
  const dataName = data === 'demo' ? ts.dataDemo : data === 'stored' ? stored?.find(d => d.id === storedId)?.name ?? ts.dataStored : ts.dataUpload;
  const sourceName = kind === 'none' ? ts.kinds.none.title : form.repo ? `${form.repo}${form.baseBranch ? ` @ ${form.baseBranch}` : ''}` : '–';

  return (
    <Dialog open={open} onClose={onClose} title={t.title} wide footer={
      <>
        <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
        {step > 0 && <Button onClick={() => setStep(step - 1)} disabled={busy}>{ts.back}</Button>}
        <Button variant="primary" type="submit" form="sbx-attach" busy={busy} disabled={!ready || !stepOk[step] || (last && !stepOk.every(Boolean))}>
          {last ? (busy ? t.submitting : t.submit) : ts.next}
        </Button>
      </>
    }>
      <form id="sbx-attach" className={styles.form} onSubmit={e => void submit(e)}>
        {dockerDown && <p className={styles.alert} role="alert">{t.dockerDown} <a href={SANDBOX_DOCS[locale]} target="_blank" rel="noreferrer">{t.guide}</a></p>}
        <ol className={styles.wizSteps} aria-label={ts.stepsLabel}>
          {ts.stepNames.map((n, i) => (
            <li key={n}>
              <button type="button" aria-current={step === i ? 'step' : undefined} disabled={i !== step && !canGo(i)} onClick={() => setStep(i)} aria-label={ts.stepOf(i + 1, n)}>
                <span aria-hidden="true">{i + 1}</span><b>{n}</b>
              </button>
            </li>
          ))}
        </ol>

        {step === 0 && <>
          <fieldset className={styles.kindList}>
            <legend>{ts.what}</legend>
            {KINDS.map(k => (
              <label key={k} className={styles.kindCard}>
                <input type="radio" name="sbx-kind" value={k} checked={kind === k} onChange={() => { setKind(k); setError(null); setAdvanced(k === 'custom'); }} />
                <span><b>{ts.kinds[k].title}</b><small>{ts.kinds[k].text}</small></span>
              </label>
            ))}
          </fieldset>
          <p className={styles.hint}>{t.lead}</p>
          <label className={styles.field}>
            <span className={styles.label}>{t.name}</span>
            <input value={form.title} maxLength={120} placeholder={t.namePlaceholder} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          </label>
        </>}

        {step === 1 && kind === 'none' && (
          <div className={`${styles.field} ${styles.newPlugin}`}>
            <p className={styles.newPluginNote}>{ts.noneLead}</p>
            <label className={styles.label} htmlFor="sbx-plugin-name">{ts.noneName}</label>
            <input id="sbx-plugin-name" value={pluginName} maxLength={61} spellCheck={false} autoComplete="off" aria-invalid={!nameOk} aria-describedby="sbx-plugin-hint"
              onChange={e => setName({ value: e.target.value.replace(/\s+/g, ''), editedFor: 'none' })} />
            <span id="sbx-plugin-hint" className={`${styles.fieldNote} ${!nameOk ? styles.fieldBad : ''}`}>{!nameOk ? t.pluginInvalid : t.pluginHint}</span>
          </div>
        )}

        {step === 1 && usesRepo && <>
          {kind === 'new' && <p className={styles.hint}>{ts.newLead}</p>}
          <label className={styles.field}>
            <span className={styles.label}><Term tech={t.repoTech}>{t.repo}</Term></span>
            <select value={form.repo} disabled={!repos?.length || !!newRepo} onChange={e => { setBranches(null); setWant(''); setRepoNote(null); setCustom(false); setModeOpen(false); setSkipHash(null); setTarget(x => ({ ...x, edited: false })); setForm(f => ({ ...f, repo: e.target.value, baseBranch: '' })); }}>
              <option value="">{repos ? t.repoPick : t.reposLoading}</option>
              {repos?.map(r => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.push ? '' : ` (${t.readOnly})`}</option>)}
            </select>
          </label>
          {repoNote && <p className={styles.okBox} role="status">{repoNote}</p>}
          {!newRepo && repos && (kind === 'new' || kind === 'existing') && <p className={styles.fieldNote}><button type="button" className={styles.textBtn} onClick={openNewRepo} title={t.newRepoTitle}>{t.newRepo}</button></p>}
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
            <select value={form.baseBranch} disabled={!branches?.length} onChange={e => { setSkipHash(null); setForm(f => ({ ...f, baseBranch: e.target.value })); }}>
              {!branches && <option value="">{form.repo ? t.branchesLoading : '–'}</option>}
              {branches?.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </label>

          {probeKey && !probed && <p className={styles.fieldNote} role="status">{ts.probing}</p>}
          {probed && kind !== 'custom' && (detected
            ? <p className={styles.chip} data-tone={detected.kind === 'unknown' || (kind === 'new' && !probed.empty) ? 'warn' : undefined} role="status">
              {ownSetup && detected.kind !== 'unknown' ? ts.detected.custom : detectedText()}
              {file?.mode === 'custom' && !custom && <small>{ts.detected.file}</small>}
              {kind === 'existing' && detected.kind !== 'unknown' && <button type="button" aria-expanded={modeOpen} onClick={() => setModeOpen(o => !o)}>{ts.change}</button>}
            </p>
            : <p className={styles.fieldNote} role="status">{ts.probeFailed}</p>)}
          {modeOpen && kind === 'existing' && detected && detected.kind !== 'unknown' && (
            <fieldset className={styles.modeList}>
              <legend>{ts.modeLabel}</legend>
              <label><input type="radio" name="sbx-mode" checked={!custom} onChange={() => setCustom(false)} />{ts.modeAuto(file?.mode === 'custom' ? `${ts.detected.custom}, ${ts.detected.file}` : detectedText())}</label>
              <label><input type="radio" name="sbx-mode" checked={custom} onChange={() => { setCustom(true); setAdvanced(true); }} />{ts.modeCustom}</label>
            </fieldset>
          )}
          {kind === 'new' && probed && probed.empty === false && <p className={styles.alert} role="alert">{ts.newNotEmpty}</p>}
          {kind === 'existing' && detected?.kind === 'unknown' && <p className={styles.fieldHint}>{ts.unknownHint(detected.reason ?? '')}</p>}
          {ownSetup && <p className={styles.fieldHint}>{ts.customHint}</p>}
          {newPlugin && probed && (
            <div className={`${styles.field} ${styles.newPlugin}`}>
              <p className={styles.newPluginNote} role="status">{t.emptyRepo}</p>
              <label className={styles.label} htmlFor="sbx-plugin-name">{t.pluginName}</label>
              <input id="sbx-plugin-name" value={pluginName} maxLength={61} placeholder="CoNineHeaderBanner" spellCheck={false} autoComplete="off"
                aria-invalid={!!pluginName && !nameOk} aria-describedby="sbx-plugin-hint" onChange={e => setName({ value: e.target.value.replace(/\s+/g, ''), editedFor: probeKey })} />
              <span id="sbx-plugin-hint" className={`${styles.fieldNote} ${pluginName && !nameOk ? styles.fieldBad : ''}`}>{pluginName && !nameOk ? t.pluginInvalid : t.pluginHint}</span>
            </div>
          )}
          {fileError && <p className={styles.bad} role="alert">{all.sandbox.repoFile.invalid(fileError)}</p>}
          {file && <RepoFileCard file={file} missingEnv={file.missingEnv} state={fileState} busy={deciding} onApprove={() => void decide(true)} onSkip={() => void decide(false)} />}

          <details className={styles.advanced} open={advanced || ownSetup || undefined} onToggle={e => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>{ts.advanced}</summary>
            <p className={styles.fieldHint}>{ts.advancedHint}</p>
            {ownSetup && (
              <label className={styles.field}>
                <span className={styles.label}>{ts.target}</span>
                <input value={targetValue} maxLength={200} spellCheck={false} autoComplete="off" aria-invalid={!!targetBad} aria-describedby="sbx-target-hint" onChange={e => setTarget({ value: e.target.value.trim(), edited: true })} />
                <span id="sbx-target-hint" className={`${styles.fieldNote} ${targetBad ? styles.fieldBad : ''}`}>{targetBad ? ts.targetInvalid[targetBad] : ts.targetHint}</span>
              </label>
            )}
            <div className={styles.field} role="group" aria-labelledby="sbx-own-cmds">
              <span id="sbx-own-cmds" className={styles.label}>{ts.commands}</span>
              <span className={styles.fieldHint}>{ts.commandsHint}</span>
              {commands.map((c, i) => (
                <div key={i} className={styles.ownRow}>
                  <input aria-label={`${ts.commandLabel} ${i + 1}`} placeholder={ts.commandLabel} value={c.label} maxLength={80} onChange={e => setCommands(l => l.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  <input aria-label={`${ts.command} ${i + 1}`} placeholder={ts.command} value={c.command} maxLength={2000} spellCheck={false} onChange={e => setCommands(l => l.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))} />
                  <select aria-label={`${all.sandbox.env.phase} ${i + 1}`} value={c.phase} onChange={e => setCommands(l => l.map((x, j) => (j === i ? { ...x, phase: e.target.value as CommandPhase } : x)))}>
                    {(['after-db', 'final'] as const).map(p => <option key={p} value={p}>{all.sandbox.repoFile.phase[p]}</option>)}
                  </select>
                  <button type="button" className={styles.x} aria-label={ts.removeCommand(c.label)} onClick={() => setCommands(l => l.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
              {commands.length < 10 && <p className={styles.fieldNote}><button type="button" className={styles.textBtn} onClick={() => setCommands(l => [...l, { label: '', command: '', phase: 'final' }])}>{ts.addCommand}</button></p>}
            </div>
            <div className={styles.field} role="group" aria-labelledby="sbx-own-vars">
              <span id="sbx-own-vars" className={styles.label}>{ts.vars}</span>
              <span className={styles.fieldHint}>{ts.varsHint}</span>
              {vars.map((v, i) => (
                <div key={i} className={`${styles.ownRow} ${styles.varRow2}`}>
                  <input aria-label={`${ts.varKey} ${i + 1}`} placeholder={ts.varKey} value={v.key} maxLength={64} spellCheck={false} aria-invalid={!!v.key && !ENV_KEY.test(v.key)} onChange={e => setVars(l => l.map((x, j) => (j === i ? { ...x, key: e.target.value.toUpperCase() } : x)))} />
                  <input aria-label={`${ts.varValue} ${i + 1}`} placeholder={ts.varValue} value={v.value} maxLength={4000} spellCheck={false} onChange={e => setVars(l => l.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <button type="button" className={styles.x} aria-label={ts.removeVar(v.key)} onClick={() => setVars(l => l.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
              {!varsOk && <span className={`${styles.fieldNote} ${styles.fieldBad}`}>{ts.varInvalid}</span>}
              {vars.length < 20 && <p className={styles.fieldNote}><button type="button" className={styles.textBtn} onClick={() => setVars(l => [...l, { key: '', value: '' }])}>{ts.addVar}</button></p>}
            </div>
          </details>
          {repos && !repos.length && !error && <p className={styles.alert}>{t.noGithub}</p>}
        </>}

        {step === 2 && <>
          <fieldset className={styles.dataList}>
            <legend>{ts.data}</legend>
            <div className={styles.dataOpt}>
              <label><input type="radio" name="sbx-data" checked={data === 'demo'} onChange={() => setData('demo')} /><span><b>{ts.dataDemo}</b><small>{ts.dataDemoText}</small></span></label>
            </div>
            <div className={styles.dataOpt}>
              <label><input type="radio" name="sbx-data" checked={data === 'stored'} disabled={!stored?.length} onChange={() => setData('stored')} /><span><b>{ts.dataStored}</b><small>{stored?.length ? ts.dataStoredText : ts.dataNoStored}</small></span></label>
              {data === 'stored' && !!stored?.length && (
                <select aria-label={ts.dataStored} value={storedId} onChange={e => setStoredId(e.target.value)}>
                  {stored.map(d => <option key={d.id} value={d.id}>{all.sandbox.dump.pickOption(d.name, d.shopwareVersion, d.size, d.snapshot)}</option>)}
                </select>
              )}
            </div>
            <div className={styles.dataOpt}>
              <label><input type="radio" name="sbx-data" checked={data === 'upload'} onChange={() => setData('upload')} /><span><b>{ts.dataUpload}</b><small>{ts.dataUploadText}</small></span></label>
              {data === 'upload' && <DumpUpload onChange={d => setUploadId(d?.id ?? null)} onBusy={setUploading} disabled={busy} />}
            </div>
          </fieldset>
          <p className={styles.wizSummary}>{ts.summary(ts.kinds[kind].title, sourceName, dataName)}</p>
        </>}
        {error && <p className={styles.bad} role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
