'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { loadFixes, type FixMap } from '@/lib/fixes';
import type { CheckFinding, CheckSeverity, SeoImpactList, SeoItem, SeoMark, SeoOnpage, SeoOverview } from '@/lib/protocol';
import { countText, severityLabel } from '@/lib/shopcheck';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { INTL_LOCALE, type Locale } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { useShell } from '@/components/shell/ShellProvider';
import { SEO_CHECK_AREAS, seoGroup, type SeoGroup } from './groups';
import { ImpactSection } from './ImpactSection';
import styles from './Seo.module.css';

const COLLAPSED = 5;
const GROUPS: SeoGroup[] = ['tech', 'ranking', 'keyword', 'content', 'check'];

/** One row, whether SEO lever or shop check finding */
interface Row { id: string; kind: string; title: string; detail: string; metrics: { label: string; value: string }[]; prompt: string; sev?: CheckSeverity; mark?: SeoMark; markable: boolean }

const fromItem = (i: SeoItem, kinds: Record<SeoItem['kind'], string>): Row => ({
  id: i.id, kind: kinds[i.kind], title: i.title, detail: i.detail, metrics: i.metrics, prompt: i.prompt, mark: i.mark, markable: true,
  sev: i.kind === 'site' ? (i.impact >= 20_000 ? 'hoch' : i.impact >= 5_000 ? 'mittel' : 'niedrig') : i.kind === 'onpage' ? (i.impact >= 10_000 ? 'hoch' : 'mittel') : i.kind === 'decline' ? 'hoch' : undefined,
});
const fromFinding = (f: CheckFinding, locale: Locale): Row => ({
  id: f.id, kind: f.area, title: f.title, detail: [countText(f, locale), f.hint].filter(Boolean).join(' · '), metrics: [], prompt: f.fixPrompt, sev: f.severity, markable: false,
});

/** SEO overview: levers from Search Console, Sistrix and the shop check; "Optimieren" (optimize) puts the ready-made task into a new chat. */
export function SeoView() {
  const { t: all, locale } = useI18n(), t = all.seo;
  const shell = useShell();
  const [data, setData] = useState<SeoOverview | null>(null);
  const [checks, setChecks] = useState<CheckFinding[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [filter, setFilter] = useState<SeoGroup | 'impact' | null>(null);
  const [effects, setEffects] = useState<SeoImpactList | null>(null);
  const [open, setOpen] = useState<Partial<Record<SeoGroup, boolean>>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [fixes, setFixes] = useState<FixMap>({});

  const load = (refresh = false) => {
    setError(''); setBusy(true);
    if (refresh) api.seoImpact().then(setEffects, () => {}); // fetching again also refreshes the impact list (stored state, no Google request)
    return api.seoOverview(refresh).then(setData, e => setError(errorText(e))).finally(() => setBusy(false));
  };
  useEffect(() => {
    let off = false;
    api.seoOverview().then(d => { if (!off) setData(d); }, e => { if (!off) setError(errorText(e)); }).finally(() => { if (!off) setBusy(false); });
    api.seoImpact().then(d => { if (!off) setEffects(d); }, () => {});
    api.shopCheck().then(s => { if (!off) setChecks((s.run?.findings ?? []).filter(f => f.count > 0 && SEO_CHECK_AREAS.has(f.area))); }, () => {});
    // only after loading: localStorage doesn't exist during server rendering
    queueMicrotask(() => { if (!off) setFixes(loadFixes()); });
    return () => { off = true; };
  }, []);

  const mark = async (id: string, state: SeoMark['state'] | null) => {
    const prev = data;
    setData(d => d && { ...d, items: d.items.map(i => (i.id === id ? { ...i, mark: state ? { state, at: new Date().toISOString() } : undefined } : i)) });
    try { await api.seoMark(id, state); } catch (e) { setData(prev); setError(errorText(e)); }
  };
  const pickProject = async (hash: string) => {
    if (!hash) return;
    setBusy(true);
    try { await api.saveSistrix({ project: hash }); await load(); } catch (e) { setError(errorText(e)); setBusy(false); }
  };

  const day = (iso: string) => new Date(iso).toLocaleDateString(INTL_LOCALE[locale]);
  const none = data && !data.gsc && !data.sistrix && !data.site, noIntegration = data && !data.gsc && !data.sistrix;
  const rows: Record<SeoGroup, Row[]> = { tech: [], ranking: [], keyword: [], content: [], check: checks.map(f => fromFinding(f, locale)) };
  for (const i of data?.items ?? []) rows[seoGroup(i)].push(fromItem(i, t.kinds));
  // Technical mixes live check and Sistrix crawl: by importance instead of by source
  const impact = new Map((data?.items ?? []).map(i => [i.id, i.impact]));
  rows.tech.sort((a, b) => (impact.get(b.id) ?? 0) - (impact.get(a.id) ?? 0));
  const visible = (g: SeoGroup) => rows[g].filter(r => showHidden || !r.mark);
  const openCount = (g: SeoGroup) => rows[g].filter(r => !r.mark).length;
  const hiddenCount = GROUPS.reduce((n, g) => n + rows[g].filter(r => r.mark).length, 0);
  const techErrors = rows.tech.some(r => !r.mark && r.sev === 'hoch');
  const active = (g: SeoGroup) => (g === 'tech' ? !!(data?.sistrix || data?.site) : g === 'keyword' ? !!data?.sistrix : g === 'content' || g === 'ranking' ? !!data?.gsc : checks.length > 0);
  const shown = GROUPS.filter(g => active(g) && (!filter || filter === g));

  const row = (r: Row) => {
    const fix = fixes[r.id];
    return (
      <li key={r.id} className={`${styles.item}${r.mark ? ` ${styles.marked}` : ''}`}>
        <div className={styles.main}>
          <span className={styles.kindRow}>
            {r.sev && <span className={`${styles.sev} ${styles[r.sev]}`}>{severityLabel(r.sev, locale)}</span>}
            <span className={styles.kind}>{r.kind}</span>
            {r.mark && <span className={styles.markTag}>{r.mark.state === 'done' ? t.markedDone(day(r.mark.at)) : t.markedIgnored(day(r.mark.at))}</span>}
          </span>
          <b>{r.title}</b>
          {r.detail && <span className={styles.detail}>{r.detail}</span>}
          {!!r.metrics.length && <ul className={styles.metrics}>{r.metrics.map(m => <li key={m.label}><small>{m.label}</small> <span>{m.value}</span></li>)}</ul>}
        </div>
        <div className={styles.actions}>
          {r.mark ? <Button size="sm" variant="ghost" onClick={() => void mark(r.id, null)}>{t.restore}</Button> : <>
            {fix ? (
              <>
                <span className={styles.badge}>{t.inProgress}</span>
                <Button size="sm" onClick={() => shell.nav.openChat(fix.chatId)} title={fix.title}>{t.openChat}</Button>
              </>
            ) : <Button variant="primary" size="sm" title={t.optimizeTitle} onClick={() => shell.nav.promptChat(r.prompt, { id: r.id, title: r.title })}>{t.optimize}</Button>}
            {r.markable && (
              <span className={styles.quiet}>
                <button type="button" title={t.doneTitle} onClick={() => void mark(r.id, 'done')}>{t.done}</button>
                <button type="button" title={t.ignoreTitle} onClick={() => void mark(r.id, 'ignored')}>{t.ignore}</button>
              </span>
            )}
          </>}
        </div>
      </li>
    );
  };

  const tile = (g: SeoGroup | 'impact' | null, label: string, n: number, warn = false) => (
    <button type="button" className={`${styles.tile}${warn && n ? ` ${styles.tileWarn}` : ''}`} aria-pressed={filter === g} onClick={() => setFilter(filter === g ? null : g)}>
      <span className={styles.tileN}>{n}</span><span className={styles.tileL}>{label}</span>
    </button>
  );

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <div className={styles.titleRow}>
          <h1 className={styles.h1}>{t.title}</h1>
          <div className={styles.stand}>
            {data && <span>{t.stand(new Date(data.generatedAt).toLocaleString(INTL_LOCALE[locale], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))} · {data.cached ? t.cached : t.fresh}</span>}
            <Button size="sm" onClick={() => void load(true)} busy={busy} disabled={busy} title={t.refreshTitle}>{busy && data ? t.refreshing : t.refresh}</Button>
          </div>
        </div>
        <p className={styles.lead}>{t.lead}</p>
        {error && <p className={styles.bad} role="alert">{t.failed(error)}</p>}
        {!data && !error && <p className={styles.muted}>{t.loading}</p>}
        {noIntegration && <div className={styles.card}><p>{t.noSource}</p><Link href="/settings/integrationen" className={styles.link}>{t.toSettings}</Link></div>}
        {data?.errors.map(e => <p key={e.source} className={styles.bad} role="alert">{t.sourceFailed(t.sources[e.source], e.error)}</p>)}

        {data && !none && (
          <div className={styles.tiles} role="group" aria-label={t.filters.all}>
            {tile(null, t.tiles.open, GROUPS.filter(active).reduce((n, g) => n + openCount(g), 0))}
            {(data.sistrix || data.site) && tile('tech', t.tiles.tech, openCount('tech'), techErrors)}
            {data.gsc && tile('ranking', t.tiles.ranking, openCount('ranking'), rows.ranking.some(r => !r.mark && r.sev === 'hoch'))}
            {data.sistrix && tile('keyword', t.tiles.keyword, openCount('keyword'))}
            {data.gsc && tile('content', t.filters.content, openCount('content'))}
            {checks.length > 0 && tile('check', t.tiles.check, openCount('check'))}
            {effects?.connected && tile('impact', t.impact.tile, effects.items.filter(i => !i.dismissed).length, effects.items.some(i => !i.dismissed && i.verdict === 'worse' && i.status !== 'superseded'))}
          </div>
        )}

        {data && !none && shown.map(g => {
          const list = visible(g), more = list.length > COLLAPSED, cut = more && !open[g] ? list.slice(0, COLLAPSED) : list;
          return (
            <section key={g} className={styles.card} aria-labelledby={`seo-${g}`}>
              <div className={styles.cardHead}>
                <h2 id={`seo-${g}`}>{t.groups[g].title} <span className={styles.count}>{openCount(g)}</span></h2>
                <span className={styles.hint}>{t.groups[g].hint}</span>
              </div>
              {g === 'tech' && data.siteChecked && <p className={styles.checked}>{t.checkedPages(data.siteChecked.pages.map(p => t.pageKinds[p.kind] ?? p.kind).join(', '))}</p>}
              {g === 'tech' && data.sistrix && data.onpage && <Onpage o={data.onpage} busy={busy} onPick={h => void pickProject(h)} />}
              {cut.length ? <ul className={styles.list}>{cut.map(row)}</ul>
                : (g !== 'tech' || !data.onpage || data.onpage.status === 'ok') && <p className={styles.muted}>{t.empty}</p>}
              {more && <button type="button" className={styles.more} onClick={() => setOpen(o => ({ ...o, [g]: !o[g] }))}>{open[g] ? t.showLess : t.showAll(list.length)}</button>}
            </section>
          );
        })}

        {data && !none && effects?.connected && (!filter || filter === 'impact') && <ImpactSection data={effects} onChange={setEffects} />}

        {data && !none && (
          <p className={styles.foot}>
            {hiddenCount > 0 && <button type="button" className={styles.more} onClick={() => setShowHidden(s => !s)}>{showHidden ? t.hideHidden : t.hidden(hiddenCount)}</button>}
            <span>{t.disclaimer}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/** OnPage status: last crawl, or why no technical errors are showing (yet), with project selection */
function Onpage({ o, busy, onPick }: { o: SeoOnpage; busy: boolean; onPick: (hash: string) => void }) {
  const { t: all, locale } = useI18n(), t = all.seo.onpage;
  const fmt = (n: number | null | undefined) => (typeof n === 'number' ? n.toLocaleString(INTL_LOCALE[locale]) : '–');
  const projects = o.projects ?? [];
  const select = projects.length > 0 && (
    <label className={styles.project}>
      <span>{t.project}</span>
      <select value={o.status === 'choose' ? '' : o.project?.hash ?? ''} disabled={busy} onChange={e => onPick(e.target.value)}>
        {o.status === 'choose' && <option value="">{t.pick}</option>}
        {projects.map(p => <option key={p.hash} value={p.hash}>{p.name}</option>)}
      </select>
    </label>
  );
  if (o.status === 'none') return <p className={styles.notice}>{t.none}</p>;
  if (o.status === 'choose') return <div className={styles.notice}><p>{t.choose}</p>{select}</div>;
  return (
    <div className={styles.crawl}>
      {o.status === 'empty' ? <span>{t.empty(o.project?.name ?? '')}</span> : o.lastCrawl && (
        <>
          <span className={styles.crawlDate}>{t.lastCrawl(new Date(o.lastCrawl.date).toLocaleDateString(INTL_LOCALE[locale]))}</span>
          <span><small>{t.pages}</small> {fmt(o.lastCrawl.pages)}</span>
          <span className={o.lastCrawl.errors ? styles.crawlBad : undefined}><small>{t.errors}</small> {fmt(o.lastCrawl.errors)}</span>
          <span><small>{t.warnings}</small> {fmt(o.lastCrawl.warnings)}</span>
          <span><small>{t.notices}</small> {fmt(o.lastCrawl.notices)}</span>
        </>
      )}
      {select}
    </div>
  );
}
