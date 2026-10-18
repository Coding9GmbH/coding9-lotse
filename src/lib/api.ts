// Typed fetch helpers for the UI (use in the browser only).
import type { FileAttachment } from './attachments';
import type { CheckListItem } from './custom-checks';
import type { KnowledgeDoc, KnowledgeLink, KnowledgeRule, RuleScope, RuleTarget } from './knowledge';
import { createLineSplitter } from './ndjson';
import type { CodexLoginState, GithubBranch, GithubPublic, GithubRepo, GithubTestResult, GscPublic, GscTestResult, SeoImpactList, SeoMark, SeoOverview, SistrixOverview, SistrixPublic, SistrixTestResult,
  AccessLogRow, AppConfig, AuditRow, CategoryRow, ChatRequest, ChatSummary, Health, ProductRow,
  CodeTaskPublic, ConsoleSessionPublic, DumpPublic, LibraryDumpPublic, NewSandboxRequest, QuickStartBroken, QuickStartPublic, QuickStartSetup, PluginZipCheck, RepoOwner, RepoProbe, TaskDiff, PublicSettings, SandboxCheckEvent, SandboxEnvPatch, SandboxEnvView, SettingsPatch, ShopCheckState, StagedImage, Styleguide, TestResult, UndoOutcome, UsageStatus,
  PrStatus, PublishRequest, PublishResult } from './protocol';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** UI identifier: the server requires it on every writing call (protection against calls from embedded previews). */
export const LOTSE_HEADER = { 'x-lotse': '1' } as const;
const withHeader = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...LOTSE_HEADER, ...(init.headers as Record<string, string> | undefined) } });

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, withHeader(init));
  const ct = r.headers.get('content-type') ?? '';
  const body: unknown = ct.includes('json') ? await r.json().catch(() => null) : await r.text().catch(() => '');
  if (!r.ok) {
    const msg = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error)
      : body && typeof body === 'object' && 'message' in body ? String((body as { message: unknown }).message)
        : typeof body === 'string' && body ? body.slice(0, 200) : `HTTP ${r.status}`;
    throw new ApiError(msg, r.status);
  }
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

export const api = {
  health: () => request<Health>('/api/health'),
  config: () => request<AppConfig>('/api/config'),
  styleguide: () => request<Styleguide | null>('/api/styleguide'),
  saveStyleguide: (sg: Styleguide) => request<Styleguide>('/api/styleguide', json('PUT', sg)),
  categories: () => request<CategoryRow[]>('/api/categories'),
  products: (term: string, categoryId?: string) =>
    request<ProductRow[]>(`/api/products?term=${encodeURIComponent(term)}${categoryId ? `&categoryId=${encodeURIComponent(categoryId)}` : ''}`),
  /** Without options the newest 200; before = last chat of the previous page (paging), q = title search */
  chats: (o: { before?: Pick<ChatSummary, 'updatedAt' | 'id'>; q?: string } = {}) => {
    const p = new URLSearchParams(); if (o.before) { p.set('before', o.before.updatedAt); p.set('beforeId', o.before.id); } if (o.q) p.set('q', o.q);
    return request<ChatSummary[]>(`/api/chats${p.size ? `?${p}` : ''}`);
  },
  deleteChat: (id: string) => request<unknown>(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  answer: (chatId: string, approvalId: string, answer: string) => request<unknown>('/api/answer', json('POST', { chatId, approvalId, answer })),
  approve: (chatId: string, approvalId: string, allow: boolean, selected?: string[]) => request<unknown>('/api/approve', json('POST', { chatId, approvalId, allow, selected })),
  stop: (chatId: string) => request<{ stopped: boolean }>('/api/chat/stop', json('POST', { chatId })),
  undo: (chatId: string, csId: string) => request<{ ok: boolean; error?: string; undoResults?: UndoOutcome[]; done?: number; total?: number }>('/api/changesets/undo', json('POST', { chatId, csId })),
  uploadFile: (file: File) =>
    request<FileAttachment & { createdAt: string }>(`/api/files?name=${encodeURIComponent(file.name || 'datei')}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file }),
  upload: (file: File) =>
    request<StagedImage>(`/api/upload?name=${encodeURIComponent(file.name || 'bild')}`, { method: 'POST', headers: { 'content-type': file.type }, body: file }),
  settings: () => request<PublicSettings>('/api/settings'),
  saveSettings: (patch: SettingsPatch) => request<PublicSettings>('/api/settings', json('PUT', patch)),
  testSettings: (target: 'shop' | 'ai') => request<TestResult>('/api/settings/test', json('POST', { target })),
  codexLogin: () => request<CodexLoginState>('/api/codex/login', { method: 'POST' }),
  codexLoginState: () => request<CodexLoginState>('/api/codex/login'),
  codexLogout: (cancel = false) => request<CodexLoginState>(`/api/codex/login${cancel ? '?cancel=1' : ''}`, { method: 'DELETE' }),
  gsc: () => request<GscPublic>('/api/gsc'),
  saveGsc: (patch: { key?: string; property?: string }) => request<GscPublic>('/api/gsc', json('PUT', patch)),
  disconnectGsc: () => request<GscPublic>('/api/gsc', { method: 'DELETE' }),
  testGsc: () => request<GscTestResult>('/api/gsc/test', { method: 'POST' }),
  sistrix: () => request<SistrixPublic>('/api/sistrix'),
  saveSistrix: (patch: { key?: string; domain?: string; country?: string; project?: string }) => request<SistrixPublic>('/api/sistrix', json('PUT', patch)),
  disconnectSistrix: () => request<SistrixPublic>('/api/sistrix', { method: 'DELETE' }),
  testSistrix: () => request<SistrixTestResult>('/api/sistrix/test', { method: 'POST' }),
  sistrixOverview: () => request<SistrixOverview>('/api/sistrix/overview'),
  github: {
    get: () => request<GithubPublic>('/api/github'),
    save: (token: string) => request<GithubPublic>('/api/github', json('PUT', { token })),
    disconnect: () => request<GithubPublic>('/api/github', { method: 'DELETE' }),
    test: () => request<GithubTestResult>('/api/github/test', { method: 'POST' }),
    repos: () => request<{ repos: GithubRepo[] }>('/api/github/repos'),
    branches: (repo: string) => request<{ branches: GithubBranch[] }>(`/api/github/branches?repo=${encodeURIComponent(repo)}`),
  },
  sandbox: {
    env: () => request<SandboxEnvView>('/api/sandbox/env'),
    save: (patch: SandboxEnvPatch) => request<SandboxEnvView>('/api/sandbox/env', json('PUT', patch)),
    /** "Umgebung prüfen": progress lines while the image is pulled, then the result */
    check: (onEvent: (ev: SandboxCheckEvent) => void, signal?: AbortSignal) => checkStream(onEvent, signal),
    tasks: () => request<{ tasks: CodeTaskPublic[] }>('/api/sandbox/tasks'),
    /** attach a sandbox to a chat (one per chat) */
    createTask: (t: NewSandboxRequest) => request<{ task: CodeTaskPublic }>('/api/sandbox/tasks', json('POST', t)),
    /** what repo@branch is before the start (empty = new plugin, plugin, theme, project, unknown) and its .lotse/sandbox.json */
    repoProbe: (repo: string, branch: string) => request<RepoProbe>(`/api/sandbox/repo-probe?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`),
    /** "Befehle erlauben" in the start dialog: the repository file's commands of exactly this content */
    approveRepoFile: (repo: string, branch: string, hash: string) => request<RepoProbe>('/api/sandbox/repo-file', json('POST', { repo, branch, hash })),
    /** the setup waits for a decision on the repository file's commands: allow them, or continue without */
    taskRepoFile: (id: string, decision: 'approve' | 'skip', hash: string) => request<{ task: CodeTaskPublic }>(`/api/sandbox/tasks/${encodeURIComponent(id)}/repo-file`, json('POST', { decision, hash })),
    /** "Als GitHub-Projekt anlegen" for a sandbox started without a project */
    githubProject: (id: string, p: { owner: string; name: string }) => request<{ task: CodeTaskPublic }>(`/api/sandbox/tasks/${encodeURIComponent(id)}/github-project`, json('POST', p)),
    /** "Neues Projekt": accounts the token may create a repository under, and creating a private one for a new plugin */
    repoOwners: () => request<{ owners: RepoOwner[] }>('/api/sandbox/repos'),
    createRepo: (p: { owner: string; name: string; description?: string }) => request<{ repo: GithubRepo }>('/api/sandbox/repos', json('POST', p)),
    /** "Plugin als ZIP herunterladen": what the ZIP would contain (problems, warnings) */
    zipCheck: (id: string, plugin?: string) => request<PluginZipCheck>(`/api/sandbox/tasks/${encodeURIComponent(id)}/plugin-zip?check=1${plugin ? `&plugin=${encodeURIComponent(plugin)}` : ''}`),
    /** the ZIP itself (streamed by the server); saved by the browser under the name the server gives */
    zipDownload: async (id: string, plugin?: string) => {
      const r = await fetch(`/api/sandbox/tasks/${encodeURIComponent(id)}/plugin-zip${plugin ? `?plugin=${encodeURIComponent(plugin)}` : ''}`, withHeader());
      if (!r.ok) { const j = await r.json().catch(() => null) as { error?: string } | null; throw new ApiError(j?.error ?? `HTTP ${r.status}`, r.status); }
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'plugin.zip';
      const url = URL.createObjectURL(await r.blob()), a = document.createElement('a');
      a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return name;
    },
    task: (id: string) => request<{ task: CodeTaskPublic }>(`/api/sandbox/tasks/${encodeURIComponent(id)}`),
    deleteTask: (id: string) => request<{ ok: true }>(`/api/sandbox/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** "Änderungen": workspace against the base branch */
    diff: (id: string) => request<TaskDiff>(`/api/sandbox/tasks/${encodeURIComponent(id)}/diff`),
    /** "Screenshot" in the preview: the configured pages of the running sandbox, desktop and mobile (only while switched on) */
    screenshot: (id: string) => request<{ task: CodeTaskPublic }>(`/api/sandbox/tasks/${encodeURIComponent(id)}/screenshots`, json('POST', {})),
    /** start | stop | pause | resume | finish; start takes the step to retry from */
    taskAction: (id: string, action: 'start' | 'stop' | 'pause' | 'resume' | 'finish', body: { fromStep?: string; ignoreVersion?: boolean } = {}) =>
      request<{ task: CodeTaskPublic }>(`/api/sandbox/tasks/${encodeURIComponent(id)}/${action}`, json('POST', body)),
    /** "Internet: an/aus" in the status line (the user's own decision; audited) */
    internet: (id: string, on: boolean) => request<{ task: CodeTaskPublic }>(`/api/sandbox/tasks/${encodeURIComponent(id)}/internet`, json('POST', { on })),
    /** "Datenbank ersetzen": import an uploaded dump into the task's sandbox */
    replaceDb: (id: string, dumpId: string) => request<{ task: CodeTaskPublic }>(`/api/sandbox/tasks/${encodeURIComponent(id)}/dump`, json('POST', { dumpId })),
    dump: (id: string) => request<{ dump: DumpPublic }>(`/api/sandbox/dumps/${encodeURIComponent(id)}`),
    deleteDump: (id: string) => request<{ ok: true }>(`/api/sandbox/dumps/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** "Gespeicherte Datenbanken": complete stored databases (metadata only) */
    storedDbs: () => request<{ dumps: LibraryDumpPublic[] }>('/api/sandbox/dumps'),
    /** "Schnellstarts" (A22): saved setups of the start dialog */
    quickStarts: () => request<{ quickStarts: QuickStartPublic[] }>('/api/sandbox/quick-starts'),
    /** save the dialog's choice, a sandbox's setup (fromTask) or a copy (duplicateOf) */
    createQuickStart: (p: { name?: string; setup?: QuickStartSetup; fromTask?: string; duplicateOf?: string; isDefault?: boolean }) =>
      request<{ quickStart: QuickStartPublic }>('/api/sandbox/quick-starts', json('POST', p)),
    updateQuickStart: (id: string, p: { name?: string; setup?: QuickStartSetup; isDefault?: boolean }) =>
      request<{ quickStart: QuickStartPublic }>(`/api/sandbox/quick-starts/${encodeURIComponent(id)}`, json('PATCH', p)),
    deleteQuickStart: (id: string) => request<{ ok: true }>(`/api/sandbox/quick-starts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** one click: started in this chat, or (422) why it cannot start as saved – the dialog then opens prefilled */
    startQuickStart: async (id: string, chatId: string): Promise<{ task: CodeTaskPublic; warnings: string[] } | { broken: QuickStartBroken }> => {
      const r = await fetch(`/api/sandbox/quick-starts/${encodeURIComponent(id)}/start`, withHeader(json('POST', { chatId })));
      const body = await r.json().catch(() => null) as ({ task: CodeTaskPublic; warnings: string[] } & QuickStartBroken) | null;
      if (r.status === 422 && body?.problems) return { broken: body };
      if (!r.ok || !body?.task) throw new ApiError(body?.error ?? `HTTP ${r.status}`, r.status);
      return { task: body.task, warnings: body.warnings ?? [] };
    },
    /** "Pull Request erstellen/aktualisieren": title and description only, the server fixes branch and base */
    publish: (id: string, p: PublishRequest) => request<PublishResult>(`/api/sandbox/tasks/${encodeURIComponent(id)}/publish`, json('POST', p)),
    prStatus: (id: string) => request<{ pr: PrStatus | null }>(`/api/sandbox/tasks/${encodeURIComponent(id)}/pr`),
    /** the user's console (tab "Konsole"): open sessions, open one (wakes a paused sandbox), input/resize, close */
    consoles: (id: string) => request<{ sessions: ConsoleSessionPublic[]; max: number }>(`/api/sandbox/tasks/${encodeURIComponent(id)}/console`),
    openConsole: (id: string, size: { cols: number; rows: number }) => request<{ session: ConsoleSessionPublic }>(`/api/sandbox/tasks/${encodeURIComponent(id)}/console`, json('POST', size)),
    consoleSend: (id: string, sid: string, body: { input: string } | { resize: { cols: number; rows: number } }) =>
      request<unknown>(`/api/sandbox/tasks/${encodeURIComponent(id)}/console/${encodeURIComponent(sid)}`, json('POST', body)),
    closeConsole: (id: string, sid: string) => request<{ ok: true }>(`/api/sandbox/tasks/${encodeURIComponent(id)}/console/${encodeURIComponent(sid)}`, { method: 'DELETE' }),
  },
  seoOverview: (refresh = false) => request<SeoOverview>(`/api/seo${refresh ? '?refresh=1' : ''}`),
  seoStored: () => request<SeoOverview | null>('/api/seo?stored=1'),
  seoMark: (id: string, state: SeoMark['state'] | null) => request<{ mark: SeoMark | null }>('/api/seo/marks', json('PUT', { id, state })),
  /** impact of applied changes: stored state (no Google request); measure = measure open changes now; dismiss = hide/show */
  seoImpact: () => request<SeoImpactList>('/api/seo/impact'),
  seoImpactMeasure: () => request<SeoImpactList & { measured: number; failed: { id: string; error: string }[] }>('/api/seo/impact', { method: 'POST' }),
  seoImpactDismiss: (id: string, dismissed: boolean) => request<SeoImpactList>('/api/seo/impact', json('PUT', { id, dismissed })),
  /** AI costs this month and the monthly budget (cost brake) */
  usage: () => request<UsageStatus>('/api/usage'),
  accessLog: () => request<AccessLogRow[]>('/api/access-log'),
  audit: () => request<AuditRow[]>('/api/audit'),
  shopCheck: () => request<ShopCheckState>('/api/shopcheck'),
  /** built-in and custom checks (on/off); creating/changing custom checks happens in the chat */
  checks: {
    list: () => request<CheckListItem[]>('/api/shopcheck/checks'),
    setEnabled: (id: string, enabled: boolean) => request<unknown>(`/api/shopcheck/checks/${encodeURIComponent(id)}`, json('PUT', { enabled })),
    remove: (id: string) => request<unknown>(`/api/shopcheck/checks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  /** starts a new run in the background */
  runShopCheck: () => request<ShopCheckState>('/api/shopcheck', { method: 'POST' }),
  knowledge: {
    list: () => request<{ docs: KnowledgeDoc[]; rules: KnowledgeRule[] }>('/api/knowledge'),
    addDoc: (fileId: string) => request<KnowledgeDoc>('/api/knowledge', json('POST', { fileId })),
    patchDoc: (id: string, patch: { title?: string; links?: KnowledgeLink[] }) => request<KnowledgeDoc>(`/api/knowledge/docs/${encodeURIComponent(id)}`, json('PATCH', patch)),
    deleteDoc: (id: string) => request<unknown>(`/api/knowledge/docs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    addRule: (text: string, scope: RuleScope, target: RuleTarget | null = null) => request<KnowledgeRule>('/api/knowledge/rules', json('POST', { text, scope, target })),
    saveRule: (id: string, text: string, scope: RuleScope, target: RuleTarget | null = null) => request<KnowledgeRule>(`/api/knowledge/rules/${encodeURIComponent(id)}`, json('PUT', { text, scope, target })),
    deleteRule: (id: string) => request<unknown>(`/api/knowledge/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
};

/** Starts the chat stream; the caller reads response.body (see useChatStream). */
export const postChat = (body: ChatRequest, signal: AbortSignal) => fetch('/api/chat', withHeader({ ...json('POST', body), signal }));
/** Connect to a chat: first "snapshot", then live events while the run is active. */
export const listenChat = (chatId: string, signal: AbortSignal) => fetch(`/api/chat?chatId=${encodeURIComponent(chatId)}`, { signal });

/** NDJSON of one code task (snapshot, then live events). */
export const listenTask = (id: string, signal: AbortSignal) => fetch(`/api/sandbox/tasks/${encodeURIComponent(id)}/events`, { signal });
/** NDJSON output of a console from chunk `from` on (ConsoleEvent lines) */
export const listenConsole = (id: string, sid: string, from: number, signal: AbortSignal) =>
  fetch(`/api/sandbox/tasks/${encodeURIComponent(id)}/console/${encodeURIComponent(sid)}?from=${from}`, { signal });

export const DUMP_CHUNK = 8 * 1024 * 1024;
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
/** Uploads a dump in chunks of 8 MB (each with its SHA-256 where the browser offers crypto.subtle), resumable:
 *  pass the id of an earlier, unfinished upload of the same file to continue after the bytes the server already has. */
export async function uploadDumpChunked(file: File, o: { resumeId?: string | null; keep?: boolean; onStart?: (id: string) => void; onProgress?: (received: number, total: number) => void; signal?: AbortSignal } = {}): Promise<DumpPublic> {
  let dump: DumpPublic | null = null;
  if (o.resumeId) {
    dump = await api.sandbox.dump(o.resumeId).then(r => r.dump, () => null);
    if (dump && (dump.size !== file.size || dump.name !== file.name || dump.status === 'deleted' || dump.library !== !!o.keep)) dump = null;
  }
  dump ??= (await request<{ dump: DumpPublic }>('/api/sandbox/dumps', json('POST', { name: file.name, size: file.size, ...(o.keep ? { keep: true } : {}) }))).dump;
  o.onStart?.(dump.id);
  if (dump.status === 'ready') return dump;
  let offset = dump.received, stuck = 0;
  o.onProgress?.(offset, file.size);
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined; // missing outside secure contexts
  while (offset < file.size) {
    const part = file.slice(offset, Math.min(file.size, offset + DUMP_CHUNK));
    const sum = subtle ? hex(await subtle.digest('SHA-256', await part.arrayBuffer())) : null;
    const r = await fetch(`/api/sandbox/dumps/${encodeURIComponent(dump.id)}?offset=${offset}`, withHeader({ method: 'PUT', body: part, signal: o.signal, headers: { 'content-type': 'application/octet-stream', ...(sum ? { 'x-chunk-sha256': sum } : {}) } }));
    const body = await r.json().catch(() => null) as { received?: number; error?: string } | null;
    if (r.status === 409 && typeof body?.received === 'number' && (body.received !== offset || ++stuck <= 5)) { // a lost answer or a chunk still being written: continue where the server is
      if (body.received === offset) await new Promise(res => setTimeout(res, 1000));
      offset = body.received; continue;
    }
    stuck = 0;
    if (!r.ok || typeof body?.received !== 'number') throw new ApiError(body?.error ?? `HTTP ${r.status}`, r.status);
    offset = body.received;
    o.onProgress?.(offset, file.size);
  }
  return (await request<{ dump: DumpPublic }>(`/api/sandbox/dumps/${encodeURIComponent(dump.id)}/complete`, { ...json('POST', {}), signal: o.signal })).dump;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function checkStream(onEvent: (ev: SandboxCheckEvent) => void, signal?: AbortSignal): Promise<void> {
  const r = await fetch('/api/sandbox/env/check', withHeader({ method: 'POST', signal }));
  if (!r.ok || !r.body) {
    const body = await r.json().catch(() => null) as { error?: unknown } | null;
    throw new ApiError(body?.error ? String(body.error) : `HTTP ${r.status}`, r.status);
  }
  const split = createLineSplitter(line => { try { onEvent(JSON.parse(line) as SandboxCheckEvent); } catch { /* ignore broken line */ } });
  const reader = r.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; split.push(value); }
  split.end();
}
