// Typed fetch helpers for the UI (use in the browser only).
import type { FileAttachment } from './attachments';
import type { CheckListItem } from './custom-checks';
import type { KnowledgeDoc, KnowledgeLink, KnowledgeRule, RuleScope, RuleTarget } from './knowledge';
import type { CodexLoginState, GscPublic, GscTestResult, SeoImpactList, SeoMark, SeoOverview, SistrixOverview, SistrixPublic, SistrixTestResult,
  AccessLogRow, AppConfig, AuditRow, CategoryRow, ChatRequest, ChatSummary, Health, ProductRow,
  PublicSettings, SettingsPatch, ShopCheckState, StagedImage, Styleguide, TestResult, UndoOutcome,
} from './protocol';

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
  seoOverview: (refresh = false) => request<SeoOverview>(`/api/seo${refresh ? '?refresh=1' : ''}`),
  seoStored: () => request<SeoOverview | null>('/api/seo?stored=1'),
  seoMark: (id: string, state: SeoMark['state'] | null) => request<{ mark: SeoMark | null }>('/api/seo/marks', json('PUT', { id, state })),
  /** impact of applied changes: stored state (no Google request); measure = measure open changes now; dismiss = hide/show */
  seoImpact: () => request<SeoImpactList>('/api/seo/impact'),
  seoImpactMeasure: () => request<SeoImpactList & { measured: number; failed: { id: string; error: string }[] }>('/api/seo/impact', { method: 'POST' }),
  seoImpactDismiss: (id: string, dismissed: boolean) => request<SeoImpactList>('/api/seo/impact', json('PUT', { id, dismissed })),
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

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
