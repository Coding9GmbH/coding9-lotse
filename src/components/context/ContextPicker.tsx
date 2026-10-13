'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { categoryPath, categoryRows, initialCollapsed, MAX_ROWS } from '@/lib/categories';
import { catalogState } from '@/lib/load-state';
import type { CategoryRow, ProductRow, Target, TargetKind } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { useShell } from '@/components/shell/ShellProvider';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { categoryNoun } from '@/lib/platforms';
import styles from './List.module.css';

interface Props { id: string; categories: CategoryRow[] | null; categoryError?: string | null; target: Target | null; onSelect: (t: Target) => void }

/** Kontext wählen: Kategorie (Baum), Produkt (Suche) oder freie Landingpage. */
export function ContextPicker({ id, categories, categoryError = null, target, onSelect }: Props) {
  const [kind, setKind] = useState<TargetKind>('category');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string> | null>(null); // null: noch nicht aus dem Baum abgeleitet
  const [loaded, setLoaded] = useState<{ q: string; products: ProductRow[]; error: string | null } | null>(null);
  const reqNo = useRef(0);
  // Shopify: Kollektionen statt Kategorien (Name je Plattform aus lib/platforms.ts)
  const { locale, t: { context: tc } } = useI18n(), t = tc.picker;
  const noun = categoryNoun(useShell().health?.platform?.kind, locale);

  useEffect(() => {
    if (kind !== 'product') return;
    const my = ++reqNo.current;
    const query = q;
    const t = setTimeout(() => {
      api.products(query.trim()).then(l => { if (my === reqNo.current) setLoaded({ q: query, products: l, error: null }); }).catch(() => { if (my === reqNo.current) setLoaded({ q: query, products: [], error: 'nicht geladen' }); });
    }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [kind, q]);

  const fresh = kind === 'product' && loaded?.q === q ? loaded : null;
  const products = fresh && !fresh.error ? fresh.products : null;
  const prodError = fresh?.error ?? null;
  const catView = catalogState(categoryError, categories);
  const prodView = catalogState(prodError, products);
  const folded = useMemo(() => collapsed ?? (categories ? initialCollapsed(categories) : new Set<string>()), [collapsed, categories]);
  const all = useMemo(() => (categories ? categoryRows(categories, q, folded) : []), [categories, q, folded]);
  const rows = all.length > MAX_ROWS ? all.slice(0, MAX_ROWS) : all; // große Bäume: nicht tausende Zeilen rendern
  const toggle = (cid: string) => setCollapsed(prev => { const n = new Set(prev ?? folded); if (n.has(cid)) n.delete(cid); else n.add(cid); return n; });

  return (
    <div id={id} className={styles.pane}>
      <Segmented label={t.kindLabel} className={styles.seg} value={kind}
        onChange={k => { setKind(k); setQ(''); }}
        options={[{ value: 'category', label: noun.one }, { value: 'product', label: t.product }, { value: 'landing', label: t.landing }]} />
      {kind !== 'landing' && (
        <input className={styles.search} type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t.search}
          aria-label={kind === 'category' ? t.searchCategories(noun.many) : t.searchProducts} />
      )}
      <div className={styles.list}>
        {kind === 'landing' && (
          <div className={styles.note}>
            <b>{t.landingTitle}</b><br />
            {t.landingText(noun.many)}<br /><br />
            <Button variant="primary" onClick={() => onSelect({ kind: 'landing', name: tc.newLanding })}>{t.planLanding}</Button>
          </div>
        )}

        {kind === 'category' && (catView === 'error' ? <div className={styles.note}>{t.notLoaded(noun.many)}</div>
          : catView === 'loading' ? <div className={styles.note}>{t.loading}</div>
          : rows.length === 0 ? <div className={styles.note}>{t.noHits}</div>
            : (
              <ul className={styles.ul} role="tree" aria-label={noun.many}>
                {rows.map(({ cat: c, depth, hasKids, open }) => (
                  <li key={c.id} role="treeitem" aria-level={depth + 1} aria-expanded={hasKids ? open : undefined} aria-selected={target?.id === c.id}
                    className={`${styles.row} ${target?.id === c.id ? styles.sel : ''} ${c.active ? '' : styles.inactive}`} style={{ paddingLeft: 8 + depth * 14 }}>
                    {hasKids
                      ? <button type="button" className={styles.tw} aria-label={open ? t.collapse(c.name) : t.expand(c.name)} onClick={() => toggle(c.id)}>{open ? '▾' : '▸'}</button>
                      : <span className={styles.tw} aria-hidden="true" />}
                    <button type="button" className={styles.pick}
                      onClick={() => { if (!categories) return; onSelect({ kind: 'category', id: c.id, name: c.name, cmsPage: c.cmsPage, path: categoryPath(categories, c) }); }}>
                      <span className={styles.nm}>{c.name}</span>
                      {c.cmsPage && <span className={styles.tag} title={t.layoutTitle(c.cmsPage)}>{t.layout}</span>}
                    </button>
                  </li>
                ))}
                {all.length > rows.length && <li className={styles.note} role="none">{t.more(all.length - rows.length, noun.many)}</li>}
              </ul>
            ))}

        {kind === 'product' && (prodView === 'error' ? <div className={styles.note}>{t.notLoaded(t.products)}</div>
          : prodView !== 'ready' && prodView !== 'empty' ? <div className={styles.note}>{t.loading}</div>
          : !products?.length ? <div className={styles.note}>{t.noHits}</div>
            : (
              <ul className={styles.ul} aria-label={t.products}>
                {products.map(p => (
                  <li key={p.id} className={`${styles.row} ${target?.id === p.id ? styles.sel : ''}`}>
                    <button type="button" className={styles.pick} aria-current={target?.id === p.id ? 'true' : undefined}
                      onClick={() => onSelect({ kind: 'product', id: p.id, name: p.name, cmsPage: p.cmsPage, path: p.number })}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- Shop-Thumbnails */}
                      {p.img ? <img src={p.img} alt="" loading="lazy" /> : <span className={styles.noimg} aria-hidden="true" />}
                      <span className={styles.nm}>{p.name}</span>
                      {p.cmsPage && <span className={styles.tag}>{t.layout}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
      </div>
    </div>
  );
}
