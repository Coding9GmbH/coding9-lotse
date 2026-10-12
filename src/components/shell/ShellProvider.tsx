'use client';

// Gemeinsamer Zustand der App-Hülle (überlebt Seitenwechsel, da im Root-Layout):
// Shop-/KI-Status, Chat-Verlauf, Styleguide-Farben, eingeklappte Navigation und die Brücke zur Arbeitsfläche.
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { NAV_COOKIE } from '@/lib/nav';
import type { ChatSummary, Health, Styleguide } from '@/lib/protocol';
import type { ShellInitial } from '@/server/initial';

/** Was die Arbeitsfläche der Navigation anbietet, solange sie angezeigt wird. */
export interface WorkspaceBridge {
  newChat: () => void;
  openChat: (id: string) => void;
  deleteChat: (id: string) => void;
  openContext: () => void;
  openStyleguide: () => void;
}
/** Auftrag an die Arbeitsfläche, wenn die Navigation von einer anderen Seite aus genutzt wird. */
export type WorkspaceIntent = { type: 'new' } | { type: 'open'; id: string } | { type: 'context' } | { type: 'styleguide' };

interface Shell {
  health: Health | null;
  refreshHealth: () => void;
  chats: ChatSummary[] | null;
  reloadChats: () => void;
  /** Chats, deren Runde im Hintergrund fertig wurde und die noch nicht wieder geöffnet wurden */
  doneIds: ReadonlySet<string>;
  styleguide: Styleguide | null;
  /** true, sobald bekannt ist, ob ein Styleguide existiert (vom Server mitgeliefert oder geladen) */
  styleguideKnown: boolean;
  /** Shop/KI eingerichtet? Sofort vom Server bekannt, später aus dem Status aktualisiert. */
  setup: { shopware: boolean; ai: boolean } | null;
  setStyleguide: (sg: Styleguide | null) => void;
  activeChatId: string | null;
  setActiveChatId: (id: string | null) => void;
  /** Name des gewählten Kontexts (Kategorie/Produkt/Landingpage) für die Navigation */
  contextName: string | null;
  setContextName: (name: string | null) => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  registerWorkspace: (bridge: WorkspaceBridge | null) => void;
  /** Holt (und löscht) einen vorgemerkten Auftrag – die Arbeitsfläche ruft das beim Start auf. */
  takeIntent: () => WorkspaceIntent | null;
  nav: { newChat: () => void; openChat: (id: string) => void; deleteChat: (id: string) => void; openContext: () => void; openStyleguide: () => void };
}

const ShellContext = createContext<Shell | null>(null);
export function ShellProvider({ children, initialCollapsed = false, initial = null }: { children: React.ReactNode; initialCollapsed?: boolean; initial?: ShellInitial | null }) {
  const router = useRouter();
  const [health, setHealth] = useState<Health | null>(null);
  const [chats, setChats] = useState<ChatSummary[] | null>(initial?.chats ?? null);
  const [styleguide, setStyleguideState] = useState<Styleguide | null>(initial?.styleguide ?? null);
  const [styleguideKnown, setStyleguideKnown] = useState(!!initial);
  const [activeChatId, setActiveChatIdState] = useState<string | null>(null);
  const [contextName, setContextName] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const activeRef = useRef<string | null>(null);
  // Geöffneter Chat gilt als gesehen
  const setActiveChatId = useCallback((id: string | null) => {
    activeRef.current = id;
    setActiveChatIdState(id);
    if (id) setDoneIds(d => { if (!d.has(id)) return d; const n = new Set(d); n.delete(id); return n; });
  }, []);
  const bridge = useRef<WorkspaceBridge | null>(null);
  const intent = useRef<WorkspaceIntent | null>(null);

  const refreshHealth = useCallback(() => {
    api.health().then(setHealth).catch(e => setHealth({ shopware: { url: '', ok: false, configured: true, error: errorText(e) }, ai: { configured: true } }));
  }, []);
  const reloadChats = useCallback(() => {
    api.chats().then(next => {
      setChats(prev => {
        // Lief ein Chat eben noch und ruht jetzt, ist er fertig – markieren, wenn er gerade nicht offen ist
        const finished = (prev ?? []).filter(p => p.status && p.id !== activeRef.current && next.some(n => n.id === p.id && !n.status)).map(p => p.id);
        if (finished.length) setDoneIds(d => new Set([...d, ...finished]));
        return next;
      });
    }).catch(() => setChats(prev => prev ?? [])); // Netzfehler: vorhandenen Verlauf behalten, nicht „Noch keine Chats“ zeigen
  }, []);

  // Solange ein Chat läuft oder wartet: Verlauf regelmäßig auffrischen (Status links aktuell halten)
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
  }, [refreshHealth, reloadChats]); // eslint-disable-line react-hooks/exhaustive-deps -- Startdaten nur beim ersten Laden

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    document.cookie = `${NAV_COOKIE}=${next ? 'collapsed' : 'open'}; path=/; max-age=31536000; samesite=lax`;
    setCollapsed(next);
  }, [collapsed]);

  // Strg/⌘ + B klappt die Navigation ein und aus
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleCollapsed(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  const setStyleguide = useCallback((sg: Styleguide | null) => { setStyleguideState(sg); setStyleguideKnown(true); }, []);
  const setup = useMemo(() => (health ? { shopware: health.shopware.configured, ai: health.ai.configured } : initial?.setup ?? null), [health, initial]);

  const value = useMemo<Shell>(() => {
    // Auf der Arbeitsfläche direkt ausführen, sonst vormerken und dorthin wechseln
    const via = (run: (b: WorkspaceBridge) => void, fallback: WorkspaceIntent) => {
      setMobileOpen(false);
      if (bridge.current) run(bridge.current);
      else { intent.current = fallback; router.push('/'); }
    };
    return {
      health, refreshHealth, chats, reloadChats, doneIds, styleguide, styleguideKnown, setup, setStyleguide, activeChatId, setActiveChatId, contextName, setContextName,
      collapsed, toggleCollapsed, mobileOpen, setMobileOpen,
      registerWorkspace: b => { bridge.current = b; },
      takeIntent: () => { const i = intent.current; intent.current = null; return i; },
      nav: {
        newChat: () => via(b => b.newChat(), { type: 'new' }),
        openChat: id => via(b => b.openChat(id), { type: 'open', id }),
        openContext: () => via(b => b.openContext(), { type: 'context' }),
        openStyleguide: () => via(b => b.openStyleguide(), { type: 'styleguide' }),
        deleteChat: id => {
          if (bridge.current) bridge.current.deleteChat(id);
          else api.deleteChat(id).catch(() => {}).finally(reloadChats);
        },
      },
    };
  }, [health, refreshHealth, chats, reloadChats, doneIds, styleguide, styleguideKnown, setup, setStyleguide, activeChatId, contextName, collapsed, toggleCollapsed, mobileOpen, router, setActiveChatId]);

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): Shell {
  const s = useContext(ShellContext);
  if (!s) throw new Error('useShell() außerhalb von <ShellProvider>');
  return s;
}
