'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ago, groupByDay, hostOf, swatches } from '@/lib/format';
import { catalogState, shellFlags } from '@/lib/load-state';
import { chatDeleteQuestion } from '@/lib/privacy-copy';
import type { ChatStatus, ChatSummary, Health } from '@/lib/protocol';
import { IconBook, IconChat, IconClose, IconHistory, IconPalette, IconPanel, IconPlus, IconSearch, IconSettings, IconTarget, IconTrash } from '@/components/ui/icons';
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

/** Linke Navigation: Neuer Chat (+ mit Kontext), Bereiche, Verlauf, Einstellungen mit Status. Einklappbar (Strg/⌘ + B), mobil als Schublade.
 * Solange Shop oder KI fehlen, ist nur die Einrichtung erreichbar: alles, was beides braucht, bleibt gesperrt. */
export function SideNav() {
  const s = useShell();
  const path = usePathname();
  const [filter, setFilter] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const collapsed = s.collapsed && !s.mobileOpen;
  const tip = (label: string) => (collapsed ? label : undefined);
  const st = status(s.health, s.healthFailed);
  const chatView = catalogState(s.chats == null ? s.chatError : null, s.chats);
  const colors = swatches(s.styleguide?.colors, 4);
  // Unbekannter Stand (noch kein Status): nicht sperren – der Server liefert ihn praktisch immer gleich mit
  const ready = !s.setup || (s.setup.shopware && s.setup.ai);
  const locked = ready ? undefined : 'Erst Shop und KI verbinden';

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
  const close = () => s.setMobileOpen(false);
  const warn = st.flags.shop === 'unloaded' || st.flags.ai === 'unloaded' || st.flags.shop === 'disconnected' || st.flags.ai === 'disconnected' || st.shop.tone === 'err';

  return (
    <nav className={cx(styles.nav, collapsed && styles.collapsed, s.mobileOpen && styles.drawerOpen)} aria-label="Hauptnavigation" id="lotse-nav">
      <div className={styles.top}>
        <Link href="/" className={styles.brand} onClick={close} aria-label="Lotse: Arbeitsfläche">
          {/* eslint-disable-next-line @next/next/no-img-element -- kleines SVG-Logo */}
          <img src="/lotse-mark.svg" alt="" width={28} height={28} />
          <span className={styles.word}>Lotse</span>
        </Link>
        <button type="button" className={cx(styles.iconBtn, styles.collapseBtn)} onClick={s.toggleCollapsed}
          aria-label={s.collapsed ? 'Navigation ausklappen' : 'Navigation einklappen'} aria-expanded={!s.collapsed} aria-controls="lotse-nav"
          data-tip={s.collapsed ? 'Ausklappen · Strg+B' : undefined} title={s.collapsed ? undefined : 'Einklappen (Strg/⌘ + B)'}>
          <IconPanel size={18} />
        </button>
        <button type="button" className={cx(styles.iconBtn, styles.closeBtn)} onClick={close} aria-label="Navigation schließen"><IconClose /></button>
      </div>

      <div className={styles.start}>
        <button type="button" className={styles.newChat} onClick={s.nav.newChat} disabled={!ready} title={locked}
          aria-label={tip('Neuer Chat')} data-tip={tip(locked ?? 'Neuer Chat')}>
          <IconPlus size={16} /><span className={styles.label}>Neuer Chat</span>
        </button>
        <button type="button" id="lotse-context" className={styles.withContext} onClick={s.nav.newChatWithContext} disabled={!ready}
          aria-label="Neuer Chat mit Kontext: Kategorie, Produkt oder Landingpage wählen" title={locked ?? 'Neuer Chat mit Kontext (Kategorie, Produkt, Landingpage)'}>
          <IconTarget size={16} />
        </button>
      </div>

      {!ready && s.setup && (
        <Link href="/settings" className={styles.setup} onClick={close} aria-label={tip('Einrichtung abschließen')} data-tip={tip('Einrichtung abschließen')}>
          <span className={styles.setupHead}><b>Einrichtung</b><span>{Number(s.setup.shopware) + Number(s.setup.ai)} von 2</span></span>
          <span className={cx(styles.setupStep, s.setup.shopware && styles.setupDone)}>Shop verbinden</span>
          <span className={cx(styles.setupStep, s.setup.ai && styles.setupDone)}>KI verbinden</span>
        </Link>
      )}

      <ul className={styles.items}>
        <li>
          <Link href="/" className={styles.item} aria-current={onWorkspace ? 'page' : undefined} onClick={close} aria-label={tip('Arbeitsfläche')} data-tip={tip('Arbeitsfläche')}>
            <IconChat size={18} /><span className={styles.label}>Arbeitsfläche</span>
            {s.contextName && onWorkspace && <span className={styles.ctx} title={`Kontext: ${s.contextName}`}>{s.contextName}</span>}
          </Link>
        </li>
        <li>
          <button type="button" className={styles.item} onClick={s.nav.openStyleguide} disabled={!ready}
            aria-label={tip(s.styleguide ? 'Styleguide' : 'Styleguide einrichten')} data-tip={tip(locked ?? (s.styleguide ? 'Styleguide' : 'Styleguide einrichten'))} title={collapsed ? undefined : locked}>
            <IconPalette size={18} />
            <span className={styles.label}>Styleguide</span>
            {ready && (colors.length ? (
              <span className={styles.swatches} aria-hidden="true">{colors.map(c => <i key={c} style={{ background: c }} />)}</span>
            ) : s.styleguide === null && <span className={styles.hint}>anlegen</span>)}
          </button>
        </li>
        <li>
          {ready ? (
            <Link href="/wissen" className={styles.item} aria-current={path === '/wissen' ? 'page' : undefined} onClick={close} aria-label={tip('Wissen')} data-tip={tip('Wissen')}>
              <IconBook size={18} /><span className={styles.label}>Wissen</span>
            </Link>
          ) : (
            <button type="button" className={styles.item} disabled aria-label={tip('Wissen')} data-tip={tip(locked ?? 'Wissen')} title={collapsed ? undefined : locked}>
              <IconBook size={18} /><span className={styles.label}>Wissen</span>
            </button>
          )}
        </li>
      </ul>

      {collapsed ? (
        <div className={styles.railFill}>
          <button type="button" className={styles.item} onClick={s.toggleCollapsed} data-tip={railTip} aria-label="Verlauf anzeigen">
            <IconHistory size={18} />
            {railState && <i className={cx(styles.pip, railState === 'waiting' && styles.pipWarn, railState === 'running' && styles.pipLive)} aria-label={STATE_LABEL[railState]} />}
          </button>
        </div>
      ) : (
        <section className={styles.history} aria-label="Verlauf">
          <div className={styles.histHead}>
            <h2>Verlauf</h2>
            {!!s.chats?.length && <span className={styles.count}>{s.chats.length}</span>}
          </div>
          {(s.chats?.length ?? 0) > 6 && (
            <label className={styles.search}>
              <IconSearch size={14} />
              <input type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Suchen" aria-label="Chats durchsuchen" />
            </label>
          )}
          <div className={styles.histList}>
            {chatView === 'loading' && <p className={styles.note}>Lade …</p>}
            {chatView === 'error' && <p className={styles.note}>Verlauf nicht geladen.</p>}
            {chatView === 'empty' && <p className={styles.note}>{ready ? 'Noch keine Chats. Starte oben mit „Neuer Chat“.' : 'Noch keine Chats. Nach der Einrichtung geht es los.'}</p>}
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
        <Link href="/settings" className={styles.settings} aria-current={path === '/settings' ? 'page' : undefined} onClick={close}
          aria-label={`Einstellungen. ${st.shop.text}. ${st.ai.text}`} data-tip={tip(`Einstellungen · ${st.shop.text} · ${st.ai.text}`)}>
          <span className={styles.gear}><IconSettings size={18} />{warn && collapsed && <i className={cx(styles.pip, styles.pipWarn)} />}</span>
          <span className={styles.label}>
            Einstellungen
            <small className={styles.sub} suppressHydrationWarning>{st.shop.text}</small>
          </span>
          <span className={styles.dots} aria-hidden="true" title={`${st.shop.text} · ${st.ai.text}`}>
            <i className={cx(styles.dot, st.shop.tone && styles[st.shop.tone])} />
            <i className={cx(styles.dot, st.ai.tone && styles[st.ai.tone])} />
          </span>
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
        <span className={styles.rowTitle}>{chatDeleteQuestion(c.title)}</span>
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
