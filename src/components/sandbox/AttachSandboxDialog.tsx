'use client';

import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { CodeTaskPublic, CommandPhase, GithubBranch, GithubRepo, LibraryDumpPublic, NewSandboxRequest, QuickStartPublic, QuickStartSetup, RepoOwner, RepoProbe, StartKind } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { PLUGIN_NAME, PREVIEW_PATH, REPO_NAME, SANDBOX_DOCS, draftOf, mediaOriginOf, pluginNameFromRepo, quickSetupOf, savedText, suggestTargetPath, targetPathProblem, type StartDraft } from '@/lib/sandbox-task';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { DumpUpload } from './DumpUpload';
import { RepoFileCard } from './RepoFileCard';
import { Term } from './Term';
import styles from './Sandbox.module.css';

export type { StartKind };
/** null: nothing chosen yet (a saved environment's stored database is gone – the user decides, A23) */
type Data = 'demo' | 'stored' | 'upload' | null;
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
 *  3. Daten – demo data (default), a stored database (the environment's default preselected) or a dump upload; "Als Umgebung
 *     speichern" keeps the choice (A22/A23).
 * Plain words first, the technical term small. Errors say what to do next. Creating attaches the sandbox to `chatId` and starts it.
 * Quick starts (A22) are this dialog's saved request: one is picked at the top of step 1 (the default one preselected), `quick` prefills
 * the dialog (a quick start that cannot start as saved, with its problems), and `editing` turns the dialog into the quick start's editor
 * (the last button saves it; no chat needed).
 */
export function AttachSandboxDialog({ open, onClose, chatId = '', initial, onCreated, dockerDown = false, quick = null, editing = null, onSaved }: {
  open: boolean; onClose: () => void; chatId?: string; initial?: { repo: string; baseBranch: string; title?: string; pluginName?: string } | null; onCreated?: (task: CodeTaskPublic) => void; dockerDown?: boolean;
  /** prefill from a quick start; problems: why it could not start as saved (shown on top) */ quick?: { id?: string; name?: string; setup: QuickStartSetup; message?: string; problems?: string[]; step?: number } | null;
  /** edit a quick start (id null = a new one) instead of starting a sandbox */ editing?: { id: string | null; name: string } | null; onSaved?: (q: QuickStartPublic) => void;
}) {
  const { t: all, locale } = useI18n();
  const t = all.sandbox.create, ts = all.sandbox.start, tq = all.sandbox.quick;
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
  // a quick start's variables kept by name only (their value comes from the environment): shown, removable, saved along
  const [envRefs, setEnvRefs] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(false);
  // A22: another image tag, the preview's first page and notes for the AI of this sandbox ('' = the environment's / none)
  const [extra, setExtra] = useState({ image: '', previewPath: '', mediaOrigin: '', notes: '' });
  const [envImage, setEnvImage] = useState('');
  // the repository file's commands: approved (server), declined for this sandbox (hash), deciding
  const [skipHash, setSkipHash] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const fileRef = useRef<HTMLDivElement>(null);
  // step 3
  const [data, setData] = useState<Data>('demo');
  const [stored, setStored] = useState<LibraryDumpPublic[] | null>(null);
  const [storedId, setStoredId] = useState('');
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [uploadKept, setUploadKept] = useState(false); // the upload is stored for further sandboxes (a saved environment may keep it)
  const [dumpGone, setDumpGone] = useState(false); // the prefilled environment's stored database no longer exists
  // saved environments (A22/A23, internally quick starts): the list, the one picked at the top, "Als Umgebung speichern" (name,
  // default), the sandbox environment's presets
  const [quicks, setQuicks] = useState<QuickStartPublic[] | null>(null);
  const [picked, setPicked] = useState('');
  const [save, setSave] = useState<{ name: string; isDefault: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [qsName, setQsName] = useState('');
  const [envPre, setEnvPre] = useState({ repo: '', baseBranch: '' });
  const [branchTick, setBranchTick] = useState(0); // a preset with the same repository again: reload its branches anyway
  const isEdit = !!editing;
  // the dialog stays mounted: a new opening (or another AI offer, another quick start) starts from its own preset
  const [shown, setShown] = useState({ open, initial, quick });
  if (shown.open !== open || shown.initial !== initial || shown.quick !== quick) {
    setShown({ open, initial, quick });
    if (open) {
      setStep(quick?.step ?? (initial?.repo ? 1 : 0)); setKind('existing'); setName({ value: '', editedFor: '' }); setForm(f => ({ ...f, title: initial?.title?.slice(0, 120) ?? '' }));
      setNewRepo(null); setRepoNote(null); setError(null); setModeOpen(false); setCustom(false); setTarget({ value: '', edited: false }); setCommands([]); setVars([]); setEnvRefs([]); setAdvanced(false); setExtra({ image: '', previewPath: '', mediaOrigin: '', notes: '' });
      setSkipHash(null); setData('demo'); setDumpGone(false); setStoredId(''); setUploadId(null); setUploadKept(false); setStored(null);
      setPicked(quick?.id ?? ''); setSave(null); setSaved(null); setQsName(editing?.name ?? '');
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

  /** Prefill from a saved environment: its first step, project and branch (once the branches are known), plugin name, own setup,
   *  "Erweitert" and the data: a stored database only while it is still stored – if it is gone, no data is chosen (not quietly the demo
   *  data): the user decides in step 3, which says why */
  function applyDraft(d: StartDraft, list: GithubRepo[] | null, dumps: LibraryDumpPublic[] | null) {
    setKind(d.kind); setError(null); setNewRepo(null); setRepoNote(null); setSkipHash(null);
    setCustom(d.custom); setModeOpen(d.custom); setTarget(d.targetPath ? { value: d.targetPath, edited: true } : { value: '', edited: false });
    setCommands(d.commands); setVars(d.vars); setEnvRefs(d.envRefs); setExtra({ image: d.image, previewPath: d.previewPath, mediaOrigin: d.mediaOrigin, notes: d.notes }); setAdvanced(d.advanced);
    // a saved name survives the probe of its own repo@branch, like a typed one
    setName(d.pluginName ? { value: d.pluginName, editedFor: d.kind === 'none' ? 'none' : `${d.repo}@${d.baseBranch}` } : { value: '', editedFor: '' });
    if (d.kind !== 'none') { setBranches(null); setWant(d.baseBranch); setBranchTick(n => n + 1); setForm(f => ({ ...f, repo: list?.some(r => r.fullName === d.repo) ? d.repo : '', baseBranch: '' })); }
    const keep = !!d.dumpId && !!dumps?.some(x => x.id === d.dumpId), gone = !!d.dumpId && !keep;
    setData(keep ? 'stored' : gone ? null : 'demo'); setDumpGone(gone); setUploadId(null);
    if (keep) setStoredId(d.dumpId!); else if (dumps?.[0]) setStoredId(dumps[0].id);
  }
  /** "Gespeicherte Umgebung" at the top of step 1: its setup, or back to the sandbox environment's presets */
  function pick(id: string) {
    setPicked(id); setSaved(null);
    const q = quicks?.find(x => x.id === id);
    applyDraft(draftOf(q ? q.setup : { kind: 'existing', repo: envPre.repo, baseBranch: envPre.baseBranch }), repos, stored);
  }

  // On open: repositories, the stored databases, the quick starts and the presets (a quick start given or the default one, else the
  // AI's proposal, else the environment's defaults)
  useEffect(() => {
    if (!open) return;
    let live = true;
    const env = api.sandbox.env().then(v => v.env, () => null);
    const dumpsP = api.sandbox.storedDbs().then(r => r.dumps, () => [] as LibraryDumpPublic[]);
    const quicksP = isEdit ? Promise.resolve([] as QuickStartPublic[]) : api.sandbox.quickStarts().then(r => r.quickStarts, () => [] as QuickStartPublic[]);
    const reposP = repos ? Promise.resolve(repos) : api.github.repos().then(r => r.repos);
    void Promise.all([env, dumpsP, quicksP]).then(([v, dumps, list]) => {
      if (!live) return;
      setStored(dumps); setEnvImage(v?.image ?? ''); setQuicks(list); setEnvPre({ repo: v?.defaultRepo ?? '', baseBranch: v?.defaultBranch ?? '' });
      const def = quick || initial?.repo ? null : list.find(q => q.default) ?? null;
      const seed = quick?.setup ?? def?.setup ?? null;
      if (def) setPicked(def.id);
      if (!seed) {
        const preset = v?.defaultDumpId && dumps.some(d => d.id === v.defaultDumpId) ? v.defaultDumpId : '';
        if (preset) { setStoredId(preset); setData('stored'); } else if (dumps[0]) setStoredId(dumps[0].id);
      }
      return reposP.catch(e => { if (live) setError(errorText(e)); return [] as GithubRepo[]; }).then(repoList => {
        if (!live) return;
        setRepos(repoList);
        if (seed) { applyDraft(draftOf(seed), repoList, dumps); return; }
        const p = initial?.repo ? { repo: initial.repo, baseBranch: initial.baseBranch } : { repo: v?.defaultRepo ?? '', baseBranch: v?.defaultBranch ?? '' };
        if (p.repo && repoList.some(r => r.fullName === p.repo)) { setBranches(null); setWant(p.baseBranch); setForm(f => ({ ...f, repo: p.repo, baseBranch: '' })); }
      });
    });
    return () => { live = false; };
  }, [open, initial, quick]); // eslint-disable-line react-hooks/exhaustive-deps -- repos only as a cache
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
  }, [form.repo, repos, want, branchTick]);

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
  // an own setup: chosen in step 1, by "ändern", by the repository file (then there is no "ändern": the file decided), or forced because
  // Lotse does not know the layout
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
  const previewBad = !!extra.previewPath.trim() && !PREVIEW_PATH.test(extra.previewPath.trim());
  const mediaBad = !!extra.mediaOrigin.trim() && !mediaOriginOf(extra.mediaOrigin);
  // the repository file's commands wait for a decision: bring the card with "Befehle erlauben" into view (it sits below the fold)
  const pendingHash = step === 1 && fileState === 'pending' ? file?.hash ?? null : null;
  useEffect(() => {
    if (pendingHash) fileRef.current?.querySelector('button')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [pendingHash]);

  const stepOk = [
    true,
    kind === 'none' ? nameOk
      : !!form.repo && !!form.baseBranch && !!probed && !newRepo && !creatingRepo && !fileError && fileState !== 'pending'
        && (kind !== 'new' || probed.empty === true) && (!newPlugin || nameOk) && !targetBad && varsOk && commandsOk && !previewBad && !mediaBad,
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

  /** The dialog's request without the chat: what starting sends and what a quick start keeps (quickSetupOf) */
  function request(): Omit<NewSandboxRequest, 'chatId'> {
    const dumpId = data === 'stored' ? storedId : data === 'upload' ? uploadId : null;
    return {
      repo: usesRepo ? form.repo : '', baseBranch: usesRepo ? form.baseBranch : '',
      ...(form.title.trim() ? { title: form.title.trim() } : {}), ...(dumpId ? { dumpId } : {}), ...(newPlugin ? { pluginName: pluginName.trim() } : {}),
      ...(kind === 'none' ? { source: 'none' as const } : {}),
      ...(ownSetup ? { mode: 'custom' as const, targetPath: targetValue } : {}),
      // own commands and variables only where "Erweitert" shows them (not for a sandbox without a project)
      ...(usesRepo && commands.length ? { commands: commands.map(c => ({ label: c.label.trim(), command: c.command.trim(), phase: c.phase })) } : {}),
      ...(usesRepo && vars.length ? { env: vars.map(v => ({ key: v.key.trim(), value: v.value })) } : {}),
      ...(usesRepo && extra.image.trim() ? { image: extra.image.trim() } : {}), ...(usesRepo && extra.previewPath.trim() ? { previewPath: extra.previewPath.trim() } : {}),
      ...(usesRepo && extra.mediaOrigin.trim() ? { mediaOrigin: extra.mediaOrigin.trim() } : {}),
      ...(usesRepo && extra.notes.trim() ? { notes: extra.notes.trim() } : {}),
      ...(file && fileState === 'skipped' ? { skipRepoHash: file.hash } : {}),
    };
  }
  /** What a quick start keeps of this choice; a one-off upload cannot be kept (null: say so) */
  const quickSetup = (): QuickStartSetup | null => (data === 'upload' && !uploadKept ? null : quickSetupOf(kind, request(), data !== 'demo', envRefs));

  /** "Als Umgebung speichern" (start dialog) and "Umgebung speichern" (editing one) */
  async function saveQuick(name: string, isDefault = false) {
    // never saved without a data choice (no quiet fall-back to the demo data), nor with an unfinished step
    if (data === null) { setError(tq.dumpGone); return; }
    if (!stepOk.every(Boolean)) return;
    const setup = quickSetup();
    if (!setup) { setError(tq.uploadOnce); return; }
    setSaving(true); setError(null); setSaved(null);
    try {
      const { quickStart } = editing?.id ? await api.sandbox.updateQuickStart(editing.id, { name: name.trim(), setup })
        : await api.sandbox.createQuickStart({ name: name.trim(), setup, ...(isDefault ? { isDefault } : {}) });
      setQuicks(l => [...(l ?? []).filter(q => q.id !== quickStart.id), quickStart]);
      onSaved?.(quickStart);
      if (isEdit) { onClose(); return; }
      // the server may have turned a variable into a reference (its value was secret): say which, and show them from now on
      setEnvRefs(quickStart.setup.envRefs ?? []);
      setPicked(quickStart.id); setSave(null); setSaved(savedText(quickStart, all));
    } catch (err) { setError(tq.saveFailed(errorText(err))); }
    finally { setSaving(false); }
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (step < 2) { if (stepOk[step]) setStep(step + 1); return; }
    if (!stepOk.every(Boolean)) return;
    if (isEdit) { await saveQuick(qsName); return; }
    setBusy(true); setError(null);
    try {
      const { task } = await api.sandbox.createTask({ chatId, ...request() });
      onCreated?.(task);
      onClose();
    } catch (err) { setError(t.failed(errorText(err))); }
    finally { setBusy(false); }
  }

  const detectedText = (): string => {
    if (!detected) return '';
    const d = ts.detected;
    return detected.kind === 'plugin' ? d.plugin(detected.name ?? '') : detected.kind === 'theme' ? d.theme(detected.name ?? '')
      : detected.kind === 'project' ? d.project(detected.plugins ?? 0, detected.root) : detected.kind === 'new' ? d.new : d.unknown;
  };
  const ready = !busy && !uploading && !saving && (isEdit || !dockerDown);
  const nameFor = () => form.title.trim() || (kind === 'none' ? pluginName.trim() : form.repo.split('/').pop() ?? '') || tq.defaultName;
  const last = step === 2;
  const dataName = data === 'demo' ? ts.dataDemo : data === 'stored' ? stored?.find(d => d.id === storedId)?.name ?? ts.dataStored : data === 'upload' ? ts.dataUpload : '–';
  const sourceName = kind === 'none' ? ts.localSource(pluginName.trim()) : form.repo ? `${form.repo}${form.baseBranch ? ` @ ${form.baseBranch}` : ''}` : '–';

  return (
    <Dialog open={open} onClose={onClose} title={editing ? (editing.id ? tq.editTitle(editing.name) : tq.newTitle) : t.title} wide footer={
      <>
        <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
        {step > 0 && <Button onClick={() => setStep(step - 1)} disabled={busy}>{ts.back}</Button>}
        <Button variant="primary" type="submit" form="sbx-attach" busy={busy || (isEdit && saving)} disabled={!ready || !stepOk[step] || (last && (!stepOk.every(Boolean) || (isEdit && !qsName.trim())))}>
          {last ? (isEdit ? tq.saveSubmit : busy ? t.submitting : t.submit) : ts.next}
        </Button>
      </>
    }>
      <form id="sbx-attach" className={styles.form} onSubmit={e => void submit(e)}>
        {quick?.problems?.length ? (
          <div className={styles.alert} role="alert">
            <p>{quick.message}</p>
            <ul className={styles.qsProblems}>{quick.problems.map(p => <li key={p}>{p}</li>)}</ul>
          </div>
        ) : null}
        {dockerDown && !isEdit && <p className={styles.alert} role="alert">{t.dockerDown} <a href={SANDBOX_DOCS[locale]} target="_blank" rel="noreferrer">{t.guide}</a></p>}
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
          {!isEdit && !!quicks?.length && (
            <label className={styles.field}>
              <span className={styles.label}>{tq.pick}</span>
              <select value={picked} onChange={e => pick(e.target.value)} aria-describedby="sbx-qs-hint">
                <option value="">{tq.pickNone}</option>
                {quicks.map(q => <option key={q.id} value={q.id}>{q.name}{q.default ? ` (${tq.isDefault})` : ''}</option>)}
              </select>
              <span id="sbx-qs-hint" className={styles.fieldNote}>{tq.pickHint}</span>
            </label>
          )}
          <fieldset className={styles.kindList}>
            <legend>{ts.what}</legend>
            {KINDS.map(k => (
              <label key={k} className={styles.kindCard}>
                <input type="radio" name="sbx-kind" value={k} checked={kind === k} onChange={() => { setKind(k); setError(null); setAdvanced(k === 'custom'); }} />
                <span><b>{ts.kinds[k].title}</b><small>{ts.kinds[k].text}</small></span>
              </label>
            ))}
          </fieldset>
          <p className={`${styles.hint} ${styles.kindLead}`} role="note">{t.lead[kind]}</p>
          {isEdit
            ? <label className={styles.field}>
              <span className={styles.label}>{tq.nameLabel}</span>
              <input value={qsName} maxLength={80} required onChange={e => setQsName(e.target.value)} />
            </label>
            : <label className={styles.field}>
              <span className={styles.label}>{t.name}</span>
              <input value={form.title} maxLength={120} placeholder={t.namePlaceholder} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
            </label>}
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
              {kind === 'existing' && detected.kind !== 'unknown' && file?.mode !== 'custom' && <button type="button" aria-expanded={modeOpen} onClick={() => setModeOpen(o => !o)}>{ts.change}</button>}
            </p>
            : <p className={styles.fieldNote} role="status">{ts.probeFailed}</p>)}
          {modeOpen && kind === 'existing' && detected && detected.kind !== 'unknown' && file?.mode !== 'custom' && (
            <fieldset className={styles.modeList}>
              <legend>{ts.modeLabel}</legend>
              <label><input type="radio" name="sbx-mode" checked={!custom} onChange={() => setCustom(false)} />{ts.modeAuto(detectedText())}</label>
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
          {file && <div ref={fileRef} className={styles.repoFileWrap}><RepoFileCard file={file} missingEnv={file.missingEnv} state={fileState} busy={deciding} onApprove={() => void decide(true)} onSkip={() => void decide(false)} /></div>}

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
              {!!envRefs.length && (
                <p className={`${styles.fieldNote} ${styles.qsRefs}`}>
                  <span>{tq.envRefs}</span>
                  {envRefs.map(k => <span key={k} className={styles.qsRef}><code>{k}</code><button type="button" className={styles.x} aria-label={tq.removeRef(k)} onClick={() => setEnvRefs(l => l.filter(x => x !== k))}>×</button></span>)}
                </p>
              )}
              {!varsOk && <span className={`${styles.fieldNote} ${styles.fieldBad}`}>{ts.varInvalid}</span>}
              {vars.length < 20 && <p className={styles.fieldNote}><button type="button" className={styles.textBtn} onClick={() => setVars(l => [...l, { key: '', value: '' }])}>{ts.addVar}</button></p>}
            </div>
            <label className={styles.field}>
              <span className={styles.label}>{ts.image}</span>
              <input value={extra.image} maxLength={120} spellCheck={false} autoComplete="off" placeholder={envImage} aria-describedby="sbx-image-hint" onChange={e => setExtra(x => ({ ...x, image: e.target.value.trim() }))} />
              <span id="sbx-image-hint" className={styles.fieldNote}>{ts.imageHint(envImage || '–')}</span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{ts.previewPath}</span>
              <input value={extra.previewPath} maxLength={300} spellCheck={false} autoComplete="off" placeholder="/" aria-invalid={previewBad} aria-describedby="sbx-start-hint" onChange={e => setExtra(x => ({ ...x, previewPath: e.target.value.trim() }))} />
              <span id="sbx-start-hint" className={`${styles.fieldNote} ${previewBad ? styles.fieldBad : ''}`}>{previewBad ? ts.previewPathInvalid : ts.previewPathHint}</span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{ts.mediaOrigin}</span>
              <input type="url" value={extra.mediaOrigin} maxLength={300} spellCheck={false} autoComplete="off" placeholder="https://www.example.com" aria-invalid={mediaBad} aria-describedby="sbx-media-hint" onChange={e => setExtra(x => ({ ...x, mediaOrigin: e.target.value.trim() }))} />
              <span id="sbx-media-hint" className={`${styles.fieldNote} ${mediaBad ? styles.fieldBad : ''}`}>{mediaBad ? ts.mediaOriginInvalid : ts.mediaOriginHint}</span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{ts.notes}</span>
              <textarea value={extra.notes} rows={3} maxLength={4000} aria-describedby="sbx-notes-hint" onChange={e => setExtra(x => ({ ...x, notes: e.target.value }))} />
              <span id="sbx-notes-hint" className={styles.fieldNote}>{ts.notesHint}</span>
            </label>
          </details>
          {repos && !repos.length && !error && <p className={styles.alert}>{t.noGithub}</p>}
        </>}

        {step === 2 && <>
          {dumpGone && data === null && <p className={styles.alert} role="status">{tq.dumpGone}</p>}
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
              {data === 'upload' && <DumpUpload onChange={d => { setUploadId(d?.id ?? null); setUploadKept(!!d?.library); }} onBusy={setUploading} disabled={busy} />}
            </div>
          </fieldset>
          <p className={styles.wizSummary}>{ts.summary(ts.kinds[kind].title, sourceName, dataName)}</p>
          {!isEdit && (
            <div className={styles.qsSave}>
              {!save && <button type="button" className={styles.textBtn} disabled={!stepOk.every(Boolean) || uploading} onClick={() => { setSave({ name: nameFor(), isDefault: false }); setSaved(null); }}>{tq.save}</button>}
              {save && (
                <div role="group" aria-label={tq.save} className={styles.qsSaveBox}>
                  <label className={styles.field}>
                    <span className={styles.label}>{tq.saveName}</span>
                    <input value={save.name} maxLength={80} autoFocus onChange={e => setSave(x => x && { ...x, name: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (save.name.trim() && stepOk.every(Boolean)) void saveQuick(save.name, save.isDefault); } }} />
                  </label>
                  <label className={styles.toggle}><input type="checkbox" checked={save.isDefault} onChange={e => setSave(x => x && { ...x, isDefault: e.target.checked })} /> {tq.saveDefault}</label>
                  <p className={styles.fieldHint}>{tq.saveHint}</p>
                  <div className={styles.footRow}>
                    <Button size="sm" variant="primary" busy={saving} disabled={!save.name.trim() || saving || !stepOk.every(Boolean)} onClick={() => void saveQuick(save.name, save.isDefault)}>{tq.saveSubmit}</Button>
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => setSave(null)}>{tq.cancel}</Button>
                  </div>
                </div>
              )}
              {saved && <p className={styles.okBox} role="status">✓ {saved}</p>}
            </div>
          )}
        </>}
        {error && <p className={styles.bad} role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
