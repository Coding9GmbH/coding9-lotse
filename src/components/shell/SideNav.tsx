'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ago, groupByDay, hostOf, swatches } from '@/lib/format';
import { catalogState, shellFlags } from '@/lib/load-state';
import type { ChatStatus, ChatSummary, Health } from '@/lib/protocol';
import { IconBook, IconChat, IconClose, IconHistory, IconLog, IconPalette, IconPanel, IconPlus, IconSearch, IconSettings, IconTarget, IconTrash } from '@/components/ui/icons';
import { useShell } from './ShellProvider';
import styles from './SideNav.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

function status(h: Health | null, healthFailed: boolean) {
  const flags = shellFlags({
    loadFailed: healthFailed,
    known: !!h && !healthFailed,
    shopConfigured: h?.shopware.configured,
    shopOk: h?.shopware.ok,
    aiConfigured: h?.ai.configured,
  });
  if (flags.shop === 'unloaded') return { shop: { tone: 'err', text: 'Shop nicht geladen' }, ai: { tone: 'err', text: 'KI nicht geladen' }, flags };
  if (!h || flags.shop === 'loading') return { shop: { tone: '', text: 'Prüfe Verbindung …' }, ai: { tone: '', text: '…' }, flags };
  const label = h.platform?.label;
  const shop = flags.shop === 'disconnected' ? { tone: 'err', text: label ? `${label}: nicht verbunden` : 'Shop nicht verbunden' }
    : h.platform && !h.platform.available ? { tone: 'err', text: `${h.platform.label}: Anbindung folgt` }
      : flags.shop === 'ok' ? { tone: 'ok', text: label ? `${label} · ${hostOf(h.shopware.url)}` : hostOf(h.shopware.url) }
        : { tone: 'err', text: label ? `${label}: nicht erreichbar` : 'Shop nicht erreichbar' };
  const ai = flags.ai === 'ok' ? { tone: 'ok', text: 'KI verbunden' } : { tone: 'err', text: 'KI nicht verbunden' };
  return { shop, ai, flags };
}

/** Linke Navigation: Neuer Chat, Bereiche, Verlauf, Status. Einklappbar (Strg/⌘ + B), mobil als Schublade. */
export function SideNav() {
  const s = useShell();
  const path = usePathname();
  const [filter, setFilter] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [hash, setHash] = useState('');
  const collapsed = s.collapsed && !s.mobileOpen;
  const st = status(s.health, s.healthFailed);
  const chatView = catalogState(s.chats == null ? s.chatError : null, s.chats);
  const colors = swatches(s.styleguide?.colors, 4);

  useEffect(() => {
    const read = () => setHash(window.location.hash);
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [path]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (s.chats ?? []).filter(c => !q || c.title.toLowerCase().includes(q) || c.target?.name?.toLowerCase().includes(q));
    return groupByDay(list);
  }, [s.chats, filter]);

  // Eingeklappt: ein Punkt am Verlauf-Symbol – wartet (wichtigster) > läuft > fertig
  const live = s.chats?.filter(c => c.status) ?? [];
  const railState: RowState | null = live.some(c => c.status === 'waiting') ? 'waiting' : live.length ? 'running' : s.doneIds.size ? 'done' : null;
  const railTip = `Verlauf (${s.chats?.length ?? 0})${live.length ? ` · ${live.length} ${live.length === 1 ? 'läuft' : 'laufen'}` : ''}${s.doneIds.size ? ` · ${s.doneIds.size} fertig` : ''}`;

  const onWorkspace = path === '/';
  const onSettings = path === '/settings' && hash !== '#protokolle';
  const onLogs = path === '/settings' && hash === '#protokolle';
  const close = () => s.setMobileOpen(false);

  return (
    <nav className={cx(styles.nav, collapsed && styles.collapsed, s.mobileOpen && styles.drawerOpen)} aria-label="Hauptnavigation" id="lotse-nav">
      <div className={styles.top}>
        <Link href="/" className={styles.brand} onClick={close} aria-label="Lotse: Arbeitsfläche">
          {/* eslint-disable-next-line @next/next/no-img-element -- kleines SVG-Logo */}
          <img src="/lotse-mark.svg" alt="" width={34} height={34} />
          <span className={styles.word}>Lotse<small>by CODING 9</small></span>
        </Link>
        <button type="button" className={cx(styles.iconBtn, styles.collapseBtn)} onClick={s.toggleCollapsed}
          aria-label={s.collapsed ? 'Navigation ausklappen' : 'Navigation einklappen'} aria-expanded={!s.collapsed} aria-controls="lotse-nav"
          data-tip={s.collapsed ? 'Ausklappen · Strg+B' : undefined} title={s.collapsed ? undefined : 'Einklappen (Strg/⌘ + B)'}>
          <IconPanel />
        </button>
        <button type="button" className={cx(styles.iconBtn, styles.closeBtn)} onClick={close} aria-label="Navigation schließen"><IconClose /></button>
      </div>

      <button type="button" className={styles.newChat} onClick={s.nav.newChat} data-tip={collapsed ? 'Neuer Chat' : undefined}>
        <IconPlus size={18} /><span className={styles.label}>Neuer Chat</span>
      </button>

      <ul className={styles.items}>
        <li>
          <Link href="/" className={styles.item} aria-current={onWorkspace ? 'page' : undefined} onClick={close} data-tip={collapsed ? 'Arbeitsfläche' : undefined}>
            <IconChat /><span className={styles.label}>Arbeitsfläche</span>
          </Link>
        </li>
        <li>
          <button type="button" className={styles.item} onClick={s.nav.openContext} data-tip={collapsed ? (s.contextName ? `Kontext: ${s.contextName}` : 'Kontext wählen') : undefined}>
            <IconTarget />
            <span className={styles.label}>Kontext{s.contextName && <small className={styles.sub}>{s.contextName}</small>}</span>
            {s.contextName && <i className={styles.pip} aria-label="Kontext gewählt" />}
          </button>
        </li>
        <li>
          <button type="button" className={styles.item} onClick={s.nav.openStyleguide} data-tip={collapsed ? (s.styleguide ? 'Styleguide' : 'Styleguide einrichten') : undefined}>
            <IconPalette />
            <span className={styles.label}>Styleguide</span>
            {colors.length ? (
              <span className={styles.swatches} aria-hidden="true">{colors.map(c => <i key={c} style={{ background: c }} />)}</span>
            ) : s.styleguide === null && <span className={styles.badge}>einrichten</span>}
          </button>
        </li>
        <li>
          <Link href="/wissen" className={styles.item} aria-current={path === '/wissen' ? 'page' : undefined} onClick={close} data-tip={collapsed ? 'Wissen' : undefined}>
            <IconBook /><span className={styles.label}>Wissen</span>
          </Link>
        </li>
        <li>
          <Link href="/settings" className={styles.item} aria-current={onSettings ? 'page' : undefined} onClick={() => { setHash(''); close(); }} data-tip={collapsed ? 'Einstellungen' : undefined}>
            <IconSettings /><span className={styles.label}>Einstellungen</span>
            {(st.flags.shop === 'unloaded' || st.flags.ai === 'unloaded' || st.flags.shop === 'disconnected' || st.flags.ai === 'disconnected') && (
              <i className={cx(styles.pip, styles.pipWarn)} aria-label={st.flags.shop === 'unloaded' || st.flags.ai === 'unloaded' ? 'Status nicht geladen' : 'Einrichtung unvollständig'} />
            )}
          </Link>
        </li>
        <li>
          <Link href="/settings#protokolle" className={styles.item} aria-current={onLogs ? 'page' : undefined} onClick={() => { setHash('#protokolle'); close(); }} data-tip={collapsed ? 'Protokolle' : undefined}>
            <IconLog /><span className={styles.label}>Protokolle</span>
          </Link>
        </li>
      </ul>

      {collapsed ? (
        <div className={styles.railFill}>
          <button type="button" className={styles.item} onClick={s.toggleCollapsed} data-tip={railTip} aria-label="Verlauf anzeigen">
            <IconHistory />
            {railState && <i className={cx(styles.pip, railState === 'waiting' && styles.pipWarn, railState === 'running' && styles.pipLive)} aria-label={STATE_LABEL[railState]} />}
          </button>
        </div>
      ) : (
        <section className={styles.history} aria-label="Verlauf">
          <div className={styles.histHead}>
            <span>Verlauf</span>
            {!!s.chats?.length && <span className={styles.count}>{s.chats.length}</span>}
          </div>
          {(s.chats?.length ?? 0) > 6 && (
            <label className={styles.search}>
              <IconSearch size={15} />
              <input type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Chats durchsuchen" aria-label="Chats durchsuchen" />
            </label>
          )}
          <div className={styles.histList}>
            {chatView === 'loading' && <p className={styles.note}>Lade …</p>}
            {chatView === 'error' && <p className={styles.note}>Verlauf nicht geladen.</p>}
            {chatView === 'empty' && <p className={styles.note}>Noch keine Chats. Starte oben mit „Neuer Chat“.</p>}
            {chatView === 'ready' && groups.length === 0 && <p className={styles.note}>Kein Treffer.</p>}
            {groups.map(g => (
              <div key={g.label} className={styles.group}>
                <h3>{g.label}</h3>
                <ul>
                  {g.items.map(c => (
                    <HistoryRow key={c.id} chat={c} state={c.status ?? (s.doneIds.has(c.id) ? 'done' : undefined)} active={onWorkspace && c.id === s.activeChatId} confirming={confirmId === c.id}
                      onOpen={() => s.nav.openChat(c.id)} onAskDelete={() => setConfirmId(c.id)} onCancel={() => setConfirmId(null)}
                      onDelete={() => { setConfirmId(null); s.nav.deleteChat(c.id); }} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className={styles.foot}>
        <Link href="/settings" className={styles.status} onClick={close} data-tip={collapsed ? `${st.shop.text} · ${st.ai.text}` : undefined}>
          <span className={styles.statusRow}><i className={cx(styles.dot, st.shop.tone && styles[st.shop.tone])} /><span className={styles.label}>{st.shop.text}</span></span>
          <span className={styles.statusRow}><i className={cx(styles.dot, st.ai.tone && styles[st.ai.tone])} /><span className={styles.label}>{st.ai.text}</span></span>
        </Link>
      </footer>
    </nav>
  );
}

type RowState = ChatStatus | 'done';
const STATE_LABEL: Record<RowState, string> = { running: 'läuft', waiting: 'wartet auf dich', done: 'fertig' };

interface RowProps { chat: ChatSummary; state?: RowState; active: boolean; confirming: boolean; onOpen: () => void; onAskDelete: () => void; onCancel: () => void; onDelete: () => void }

function HistoryRow({ chat: c, state, active, confirming, onOpen, onAskDelete, onCancel, onDelete }: RowProps) {
  if (confirming) {
    return (
      <li className={cx(styles.row, styles.confirm)}>
        <span className={styles.rowTitle}>„{c.title}“ löschen?</span>
        <span className={styles.confirmBtns}>
          <button type="button" className={styles.yes} onClick={onDelete} autoFocus>Löschen</button>
          <button type="button" onClick={onCancel}>Abbrechen</button>
        </span>
      </li>
    );
  }
  return (
    <li className={cx(styles.row, active && styles.active)}>
      <button type="button" className={styles.openBtn} onClick={onOpen} aria-current={active ? 'true' : undefined} title={c.title}>
        <span className={styles.rowTitle}>
          {state && <i className={cx(styles.state, styles[state])} aria-hidden="true" />}{c.title}
        </span>
        <small>
          {state && <span className={cx(styles.stateText, styles[state])}>{STATE_LABEL[state]} · </span>}
          {c.target?.name && <>{c.target.name} · </>}<time dateTime={c.updatedAt} suppressHydrationWarning>{ago(c.updatedAt)}</time>
          {c.published > 0 && <span className={styles.pub} title={`${c.published}× veröffentlicht`}> · ✓ {c.published}</span>}
        </small>
      </button>
      <button type="button" className={styles.del} onClick={onAskDelete} aria-label={`Chat „${c.title}“ löschen`} title="Löschen"><IconTrash size={15} /></button>
    </li>
  );
}
