'use client';

// Shared state of the app shell (survives page changes since it lives in the root layout):
// shop/AI status, chat history, styleguide colors, collapsed navigation and the bridge to the workspace.
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { NAV_COOKIE, mergeChatPages, pageFull, rollChatPages } from '@/lib/nav';
import type { ChatSummary, Health, Styleguide } from '@/lib/protocol';
import type { ShellInitial } from '@/server/initial';

/** What the workspace offers the navigation while it is displayed. */
export interface WorkspaceBridge {
  newChat: () => void;
  openChat: (id: string) => void;
  deleteChat: (id: string) => void;
  openContext: () => void;
  openStyleguide: () => void;
  /** Open the styleguide dialog with the rules, even without an analyzed styleguide */
  openRules: () => void;
  /** Put the task text into the input field (sending stays a separate click) */
  prefill: (text: string, fix?: PromptFix) => void;
}
/** Task for the workspace when the navigation is used from another page. */
export type WorkspaceIntent = { type: 'new' } | { type: 'new-context' } | { type: 'open'; id: string } | { type: 'context' } | { type: 'styleguide' } | { type: 'rules' } | { type: 'prompt'; text: string; fix?: PromptFix };
/** Task belongs to a finding/lever: "in progress" after sending (shop check and SEO share this) */
export interface PromptFix { id: string; title: string }

interface Shell {
  health: Health | null;
  refreshHealth: () => void;
  chats: ChatSummary[] | null;
  /** Set when the chat list could not be loaded and no list is available yet. */
  chatError: string | null;
  /** Status fetch failed: do not assume shop and AI are set up. */
  healthFailed: boolean;
  reloadChats: () => void;
  /** Load older chats (the list comes in pages of 200) */
  moreChats: boolean;
  moreState: 'idle' | 'loading' | 'error';
  loadMoreChats: () => void;
  /** Chats whose turn finished in the background and that have not been reopened yet */
  doneIds: ReadonlySet<string>;
  styleguide: Styleguide | null;
  /** true as soon as it is known whether a styleguide exists (supplied by the server or loaded) */
  styleguideKnown: boolean;
  /** Shop/AI set up? Known immediately from the server, later updated from the status. */
  setup: { shopware: boolean; ai: boolean } | null;
  /** Sandbox Coding switched on (from the server first, then from the status) */
  sandbox: boolean;
  setStyleguide: (sg: Styleguide | null) => void;
  activeChatId: string | null;
  setActiveChatId: (id: string | null) => void;
  /** Name of the selected context (category/product/landing page) for the navigation */
  contextName: string | null;
  setContextName: (name: string | null) => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  registerWorkspace: (bridge: WorkspaceBridge | null) => void;
  /** Fetches (and clears) a queued task; the workspace calls this on start. */
  takeIntent: () => WorkspaceIntent | null;
  nav: { newChat: () => void; newChatWithContext: () => void; openChat: (id: string) => void; deleteChat: (id: string) => void; openContext: () => void; openStyleguide: () => void; openRules: () => void; /** New chat with a prepared task (e.g. from the SEO overview) */ promptChat: (text: string, fix?: PromptFix) => void };
}

const ShellContext = createContext<Shell | null>(null);
export function ShellProvider({ children, initialCollapsed = false, initial = null }: { children: React.ReactNode; initialCollapsed?: boolean; initial?: ShellInitial | null }) {
  const router = useRouter();
  const [health, setHealth] = useState<Health | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [chats, setChats] = useState<ChatSummary[] | null>(initial?.chats ?? null);
  const [chatError, setChatError] = useState<string | null>(null);
  // Older pages loaded later; the first page (chats) keeps refreshing as before
  const [older, setOlder] = useState<ChatSummary[]>([]);
  const [olderMore, setOlderMore] = useState<boolean | null>(null);
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'error'>('idle');
  const removed = useRef(new Set<string>());
  const [styleguide, setStyleguideState] = useState<Styleguide | null>(initial?.styleguide ?? null);
  const [styleguideKnown, setStyleguideKnown] = useState(!!initial);
  const [activeChatId, setActiveChatIdState] = useState<string | null>(null);
  const [contextName, setContextName] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const activeRef = useRef<string | null>(null);
  // An opened chat counts as seen
  const setActiveChatId = useCallback((id: string | null) => {
    activeRef.current = id;
    setActiveChatIdState(id);
    if (id) setDoneIds(d => { if (!d.has(id)) return d; const n = new Set(d); n.delete(id); return n; });
  }, []);
  const bridge = useRef<WorkspaceBridge | null>(null);
  const intent = useRef<WorkspaceIntent | null>(null);

  const refreshHealth = useCallback(() => {
    api.health().then(h => { setHealth(h); setHealthFailed(false); }).catch(() => { setHealthFailed(true); });
  }, []);
  const reloadChats = useCallback(() => {
    api.chats().then(next => {
      setChatError(null);
      setChats(prev => {
        // If a chat was just running and is now idle, it is done: mark it if it is not currently open
        const finished = (prev ?? []).filter(p => p.status && p.id !== activeRef.current && next.some(n => n.id === p.id && !n.status)).map(p => p.id);
        if (finished.length) setDoneIds(d => new Set([...d, ...finished]));
        setOlder(o => rollChatPages(prev, next, o, removed.current));
        return next;
      });
    }).catch(e => setChats(prev => {
      // Keep the existing history. Without a list this is a load error, not an empty chat list.
      if (prev == null) setChatError(errorText(e));
      return prev;
    }));
  }, []);

  const allChats = useMemo(() => mergeChatPages(chats, older), [chats, older]);
  const moreChats = olderMore ?? pageFull(chats?.length ?? 0);
  const loadMoreChats = useCallback(() => {
    const last = allChats?.at(-1);
    if (!last) return;
    setMoreState('loading');
    api.chats({ before: last }).then(page => {
      setOlder(o => { const ids = new Set(o.map(c => c.id)); return [...o, ...page.filter(c => !ids.has(c.id) && !removed.current.has(c.id))]; });
      setOlderMore(pageFull(page.length)); setMoreState('idle');
    }).catch(() => setMoreState('error'));
  }, [allChats]);

  // While a chat is running or waiting: refresh the history regularly (keep the status on the left current)
  const anyLive = !!chats?.some(c => c.status);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(reloadChats, 2500);
    return () => clearInterval(t);
  }, [anyLive, reloadChats]);


  useEffect(() => {
    refreshHealth();
    reloadChats();
    if (!initial) api.styleguide().then(sg => { setStyleguideState(sg && typeof sg === 'object' ? sg : null); setStyleguideKnown(true); }).catch(() => {});
  }, [refreshHealth, reloadChats]); // eslint-disable-line react-hooks/exhaustive-deps -- initial data only on first load

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    document.cookie = `${NAV_COOKIE}=${next ? 'collapsed' : 'open'}; path=/; max-age=31536000; samesite=lax`;
    setCollapsed(next);
  }, [collapsed]);

  // Ctrl/⌘ + B collapses and expands the navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleCollapsed(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  const setStyleguide = useCallback((sg: Styleguide | null) => { setStyleguideState(sg); setStyleguideKnown(true); }, []);
  const setup = useMemo(() => (health ? { shopware: health.shopware.configured, ai: health.ai.configured } : initial?.setup ?? null), [health, initial]);

  const sandbox = health ? !!health.sandbox?.enabled : !!initial?.sandbox;

  const value = useMemo<Shell>(() => {
    // Run directly on the workspace, otherwise queue it and switch there
    const via = (run: (b: WorkspaceBridge) => void, fallback: WorkspaceIntent) => {
      setMobileOpen(false);
      if (bridge.current) run(bridge.current);
      else { intent.current = fallback; router.push('/'); }
    };
    return {
      health, healthFailed, refreshHealth, chats: allChats, chatError, reloadChats, moreChats, moreState, loadMoreChats, doneIds, styleguide, styleguideKnown, setup, sandbox, setStyleguide, activeChatId, setActiveChatId, contextName, setContextName,
      collapsed, toggleCollapsed, mobileOpen, setMobileOpen,
      registerWorkspace: b => { bridge.current = b; },
      takeIntent: () => { const i = intent.current; intent.current = null; return i; },
      nav: {
        newChat: () => via(b => b.newChat(), { type: 'new' }),
        // New chat and pick the context right away (otherwise Lotse infers it from the message)
        newChatWithContext: () => via(b => { b.newChat(); b.openContext(); }, { type: 'new-context' }),
        openChat: id => via(b => b.openChat(id), { type: 'open', id }),
        openContext: () => via(b => b.openContext(), { type: 'context' }),
        openStyleguide: () => via(b => b.openStyleguide(), { type: 'styleguide' }),
        openRules: () => via(b => b.openRules(), { type: 'rules' }),
        promptChat: (text, fix) => via(b => { b.newChat(); b.prefill(text, fix); }, { type: 'prompt', text, fix }),
        deleteChat: id => {
          removed.current.add(id); setOlder(o => o.filter(c => c.id !== id));
          if (bridge.current) bridge.current.deleteChat(id);
          else api.deleteChat(id).catch(() => {}).finally(reloadChats);
        },
      },
    };
  }, [health, healthFailed, refreshHealth, allChats, chatError, reloadChats, moreChats, moreState, loadMoreChats, doneIds, styleguide, styleguideKnown, setup, sandbox, setStyleguide, activeChatId, contextName, collapsed, toggleCollapsed, mobileOpen, router, setActiveChatId]);

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): Shell {
  const s = useContext(ShellContext);
  if (!s) throw new Error('useShell() außerhalb von <ShellProvider>');
  return s;
}
