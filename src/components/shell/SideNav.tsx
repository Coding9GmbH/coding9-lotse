'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ago, groupByDay, hostOf, swatches } from '@/lib/format';
import { catalogState, shellFlags } from '@/lib/load-state';
import { filterHistory, historyContexts, setupReady } from '@/lib/nav';
import { chatDeleteQuestion } from '@/lib/privacy-copy';
import { PLATFORM_SETTINGS } from '@/lib/platforms';
import type { ChatStatus, ChatSummary, Health } from '@/lib/protocol';
import type { Messages } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { LanguageSwitch } from '@/components/i18n/LanguageSwitch';
import { IconBook, IconChat, IconClose, IconHistory, IconPalette, IconPanel, IconPlus, IconSearch, IconSettings, IconTarget, IconTrash } from '@/components/ui/icons';
import { useShell } from './ShellProvider';
import styles from './SideNav.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

function status(h: Health | null, healthFailed: boolean, t: Messages['nav']['status']) {
  const flags = shellFlags({
    loadFailed: healthFailed,
    known: !!h && !healthFailed,
    shopConfigured: h?.shopware.configured,
    shopOk: h?.shopware.ok,
    aiConfigured: h?.ai.configured,
  });
  if (flags.shop === 'unloaded') return { shop: { tone: 'err', text: t.shopUnloaded }, ai: { tone: 'err', text: t.aiUnloaded }, flags };
  if (!h || flags.shop === 'loading') return { shop: { tone: '', text: t.checking }, ai: { tone: '', text: '…' }, flags };
  const label = h.platform && (PLATFORM_SETTINGS[h.platform.kind]?.alpha ? t.platformAlpha(h.platform.label) : h.platform.label);
  const shop = flags.shop === 'disconnected' ? { tone: 'err', text: label ? t.platformDisconnected(label) : t.shopDisconnected }
    : h.platform && !h.platform.available ? { tone: 'err', text: t.platformComing(h.platform.label) }
      : flags.shop === 'ok' ? { tone: 'ok', text: label ? `${label} · ${hostOf(h.shopware.url)}` : hostOf(h.shopware.url) }
        : { tone: 'err', text: label ? t.platformUnreachable(label) : t.shopUnreachable };
  const ai = flags.ai === 'ok' ? { tone: 'ok', text: t.aiConnected } : { tone: 'err', text: t.aiDisconnected };
  return { shop, ai, flags };
}

/** Left navigation: new chat (+ with context), areas, history, settings with status. Collapsible (Ctrl/⌘ + B), a drawer on mobile.
 * While the shop or AI is missing, only the setup is reachable: everything that needs both stays locked. */
export function SideNav() {
  const s = useShell();
  const path = usePathname();
  const { t: all, locale } = useI18n();
  const t = all.nav;
  const [filter, setFilter] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [ctx, setCtx] = useState<string | null>(null); // history for one context only
  const collapsed = s.collapsed && !s.mobileOpen;
  const tip = (label: string) => (collapsed ? label : undefined);
  const st = status(s.health, s.healthFailed, t.status);
  const chatView = catalogState(s.chats == null ? s.chatError : null, s.chats);
  const colors = swatches(s.styleguide?.colors, 4);
  const ready = setupReady(s.setup);
  const locked = ready ? undefined : t.locked;

  const contexts = useMemo(() => historyContexts(s.chats ?? []), [s.chats]);
  const activeCtx = ctx && contexts.includes(ctx) ? ctx : null;
  const groups = useMemo(() => groupByDay(filterHistory(s.chats ?? [], filter, activeCtx), new Date(), locale), [s.chats, filter, activeCtx, locale]);

  // Collapsed: a dot on the history icon: waiting (most important) > running > done
  const live = s.chats?.filter(c => c.status) ?? [];
  const railState: RowState | null = live.some(c => c.status === 'waiting') ? 'waiting' : live.length ? 'running' : s.doneIds.size ? 'done' : null;
  const railTip = t.railTip(s.chats?.length ?? 0, live.length, s.doneIds.size);

  const onWorkspace = path === '/';
  const close = () => s.setMobileOpen(false);
  const warn = st.flags.shop === 'unloaded' || st.flags.ai === 'unloaded' || st.flags.shop === 'disconnected' || st.flags.ai === 'disconnected' || st.shop.tone === 'err';

  return (
    <nav className={cx(styles.nav, collapsed && styles.collapsed, s.mobileOpen && styles.drawerOpen)} aria-label={t.main} id="lotse-nav">
      <div className={styles.top}>
        <Link href="/" className={styles.brand} onClick={close} aria-label={t.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element -- small SVG logo */}
          <img src="/lotse-mark.svg" alt="" width={28} height={28} />
          <span className={styles.word}>Lotse</span>
        </Link>
        <button type="button" className={cx(styles.iconBtn, styles.collapseBtn)} onClick={s.toggleCollapsed}
          aria-label={s.collapsed ? t.expand : t.collapse} aria-expanded={!s.collapsed} aria-controls="lotse-nav"
          data-tip={s.collapsed ? t.expandTip : undefined} title={s.collapsed ? undefined : t.collapseTitle}>
          <IconPanel size={18} />
        </button>
        <button type="button" className={cx(styles.iconBtn, styles.closeBtn)} onClick={close} aria-label={t.close}><IconClose /></button>
      </div>

      <div className={styles.start}>
        <button type="button" className={styles.newChat} onClick={s.nav.newChat} disabled={!ready} title={locked}
          aria-label={tip(t.newChat)} data-tip={tip(locked ?? t.newChat)}>
          <IconPlus size={16} /><span className={styles.label}>{t.newChat}</span>
        </button>
        <button type="button" id="lotse-context" className={styles.withContext} onClick={s.nav.newChatWithContext} disabled={!ready}
          aria-label={t.newChatWithContext} title={locked ?? t.newChatWithContextTitle}>
          <IconTarget size={16} />
        </button>
      </div>

      {!ready && s.setup && (
        <Link href="/settings" className={styles.setup} onClick={close} aria-label={tip(t.setup.finish)} data-tip={tip(t.setup.finish)}>
          <span className={styles.setupHead}><b>{t.setup.title}</b><span>{t.setup.progress(Number(s.setup.shopware) + Number(s.setup.ai))}</span></span>
          <span className={cx(styles.setupStep, s.setup.shopware && styles.setupDone)}>{t.setup.shop}</span>
          <span className={cx(styles.setupStep, s.setup.ai && styles.setupDone)}>{t.setup.ai}</span>
        </Link>
      )}

      <ul className={styles.items}>
        <li>
          <Link href="/" className={styles.item} aria-current={onWorkspace ? 'page' : undefined} onClick={close} aria-label={tip(t.workspace)} data-tip={tip(t.workspace)}>
            <IconChat size={18} /><span className={styles.label}>{t.workspace}</span>
            {s.contextName && onWorkspace && <span className={styles.ctx} title={t.context(s.contextName)}>{s.contextName}</span>}
          </Link>
        </li>
        <li>
          <button type="button" className={styles.item} onClick={s.nav.openStyleguide} disabled={!ready}
            aria-label={tip(s.styleguide ? t.styleguide : t.styleguideSetup)} data-tip={tip(locked ?? (s.styleguide ? t.styleguide : t.styleguideSetup))} title={collapsed ? undefined : locked}>
            <IconPalette size={18} />
            <span className={styles.label}>{t.styleguide}</span>
            {ready && (colors.length ? (
              <span className={styles.swatches} aria-hidden="true">{colors.map(c => <i key={c} style={{ background: c }} />)}</span>
            ) : s.styleguide === null && <span className={styles.hint}>{t.styleguideCreate}</span>)}
          </button>
        </li>
        {ready && ( // always: the technical check of the shop pages needs no connection
          <li>
            <Link href="/seo" className={styles.item} aria-current={path === '/seo' ? 'page' : undefined} onClick={close} aria-label={tip(t.seo)} data-tip={tip(t.seo)}>
              <IconTarget size={18} /><span className={styles.label}>{t.seo}</span>
            </Link>
          </li>
        )}
        <li>
          {ready ? (
            <Link href="/wissen" className={styles.item} aria-current={path === '/wissen' ? 'page' : undefined} onClick={close} aria-label={tip(t.knowledge)} data-tip={tip(t.knowledge)}>
              <IconBook size={18} /><span className={styles.label}>{t.knowledge}</span>
            </Link>
          ) : (
            <button type="button" className={styles.item} disabled aria-label={tip(t.knowledge)} data-tip={tip(locked ?? t.knowledge)} title={collapsed ? undefined : locked}>
              <IconBook size={18} /><span className={styles.label}>{t.knowledge}</span>
            </button>
          )}
        </li>
      </ul>

      {collapsed ? (
        <div className={styles.railFill}>
          <button type="button" className={styles.item} onClick={s.toggleCollapsed} data-tip={railTip} aria-label={t.showHistory}>
            <IconHistory size={18} />
            {railState && <i className={cx(styles.pip, railState === 'waiting' && styles.pipWarn, railState === 'running' && styles.pipLive)} aria-label={t.state[railState]} />}
          </button>
        </div>
      ) : (
        <section className={styles.history} aria-label={t.history}>
          <div className={styles.histHead}>
            <h2>{t.history}</h2>
            {!!s.chats?.length && <span className={styles.count}>{s.chats.length}</span>}
          </div>
          {(s.chats?.length ?? 0) > 6 && (
            <label className={styles.search}>
              <IconSearch size={14} />
              <input type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder={t.search} aria-label={t.searchChats} />
            </label>
          )}
          {contexts.length > 0 && (
            <div className={styles.ctxFilter} role="group" aria-label={t.filterByContext}>
              <button type="button" aria-pressed={!activeCtx} onClick={() => setCtx(null)}>{t.all}</button>
              {contexts.map(n => <button key={n} type="button" aria-pressed={activeCtx === n} onClick={() => setCtx(activeCtx === n ? null : n)} title={n}>{n}</button>)}
            </div>
          )}
          <div className={styles.histList}>
            {chatView === 'loading' && <p className={styles.note}>{t.loading}</p>}
            {chatView === 'error' && <p className={styles.note}>{t.historyFailed}</p>}
            {chatView === 'empty' && <p className={styles.note}>{ready ? t.emptyReady : t.emptySetup}</p>}
            {chatView === 'ready' && groups.length === 0 && <p className={styles.note}>{t.noMatch}</p>}
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
            {chatView === 'ready' && s.moreChats && (
              <button type="button" className={styles.more} onClick={s.loadMoreChats} disabled={s.moreState === 'loading'} aria-busy={s.moreState === 'loading'}>
                {s.moreState === 'loading' ? t.loadingMore : s.moreState === 'error' ? `${t.loadMoreFailed} ${t.loadMore}` : t.loadMore}
              </button>
            )}
          </div>
        </section>
      )}

      <footer className={styles.foot}>
        {!collapsed && <LanguageSwitch className={styles.lang} />}
        <Link href="/settings" className={styles.settings} aria-current={path?.startsWith('/settings') ? 'page' : undefined} onClick={close}
          aria-label={t.settingsLabel(st.shop.text, st.ai.text)} data-tip={tip(t.settingsTip(st.shop.text, st.ai.text))}>
          <span className={styles.gear}><IconSettings size={18} />{warn && collapsed && <i className={cx(styles.pip, styles.pipWarn)} />}</span>
          <span className={styles.label}>
            {t.settings}
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

interface RowProps { chat: ChatSummary; state?: RowState; active: boolean; confirming: boolean; onOpen: () => void; onAskDelete: () => void; onCancel: () => void; onDelete: () => void }

function HistoryRow({ chat: c, state, active, confirming, onOpen, onAskDelete, onCancel, onDelete }: RowProps) {
  const { t, locale } = useI18n();
  if (confirming) {
    return (
      <li className={cx(styles.row, styles.confirm)}>
        <span className={styles.rowTitle}>{chatDeleteQuestion(c.title, locale)}</span>
        <span className={styles.confirmBtns}>
          <button type="button" className={styles.yes} onClick={onDelete} autoFocus>{t.common.delete}</button>
          <button type="button" onClick={onCancel}>{t.common.cancel}</button>
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
          {state && <span className={cx(styles.stateText, styles[state])}>{t.nav.state[state]} · </span>}
          {c.target?.name && <>{c.target.name} · </>}<time dateTime={c.updatedAt} suppressHydrationWarning>{ago(c.updatedAt, undefined, locale)}</time>
          {c.published > 0 && <span className={styles.pub} title={t.nav.published(c.published)}> · ✓ {c.published}</span>}
        </small>
      </button>
      <button type="button" className={styles.del} onClick={onAskDelete} aria-label={t.nav.deleteChat(c.title)} title={t.common.delete}><IconTrash size={15} /></button>
    </li>
  );
}
