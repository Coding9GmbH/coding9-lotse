'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { categoryPath, categoryRows, initialCollapsed, MAX_ROWS } from '@/lib/categories';
import type { CategoryRow, ProductRow, Target, TargetKind } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { useShell } from '@/components/shell/ShellProvider';
import { PLATFORM_SETTINGS } from '@/lib/platforms';
import styles from './List.module.css';

interface Props { id: string; categories: CategoryRow[] | null; target: Target | null; onSelect: (t: Target) => void }

/** Kontext wählen: Kategorie (Baum), Produkt (Suche) oder freie Landingpage. */
export function ContextPicker({ id, categories, target, onSelect }: Props) {
  const [kind, setKind] = useState<TargetKind>('category');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string> | null>(null); // null: noch nicht aus dem Baum abgeleitet
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const reqNo = useRef(0);
  // Shopify: Kollektionen statt Kategorien (Name je Plattform aus lib/platforms.ts)
  const kindOf = useShell().health?.platform?.kind, noun = (kindOf && PLATFORM_SETTINGS[kindOf].categoryNoun) || { one: 'Kategorie', many: 'Kategorien' };

  useEffect(() => {
    if (kind !== 'product') return;
    const my = ++reqNo.current;
    const t = setTimeout(() => {
      api.products(q.trim()).then(l => { if (my === reqNo.current) setProducts(l); }).catch(() => { if (my === reqNo.current) setProducts([]); });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [kind, q]);

  const folded = useMemo(() => collapsed ?? (categories ? initialCollapsed(categories) : new Set<string>()), [collapsed, categories]);
  const all = useMemo(() => (categories ? categoryRows(categories, q, folded) : []), [categories, q, folded]);
  const rows = all.length > MAX_ROWS ? all.slice(0, MAX_ROWS) : all; // große Bäume: nicht tausende Zeilen rendern
  const toggle = (cid: string) => setCollapsed(prev => { const n = new Set(prev ?? folded); if (n.has(cid)) n.delete(cid); else n.add(cid); return n; });

  return (
    <div id={id} className={styles.pane}>
      <Segmented label="Art des Kontexts" className={styles.seg} value={kind}
        onChange={k => { setKind(k); setQ(''); }}
        options={[{ value: 'category', label: noun.one }, { value: 'product', label: 'Produkt' }, { value: 'landing', label: 'Landingpage' }]} />
      {kind !== 'landing' && (
        <input className={styles.search} type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Suchen …"
          aria-label={kind === 'category' ? `${noun.many} suchen` : 'Produkte suchen'} />
      )}
      <div className={styles.list}>
        {kind === 'landing' && (
          <div className={styles.note}>
            <b>Freie Landingpage</b><br />
            Eine eigenständige Seite mit eigener URL, unabhängig von {noun.many}. Beschreibe im Chat Thema und Ziel.<br /><br />
            <Button variant="primary" onClick={() => onSelect({ kind: 'landing', name: 'Neue Landingpage' })}>Neue Landingpage planen</Button>
          </div>
        )}

        {kind === 'category' && (categories === null ? <div className={styles.note}>Lade …</div>
          : rows.length === 0 ? <div className={styles.note}>Keine Treffer.</div>
            : (
              <ul className={styles.ul} role="tree" aria-label={noun.many}>
                {rows.map(({ cat: c, depth, hasKids, open }) => (
                  <li key={c.id} role="treeitem" aria-level={depth + 1} aria-expanded={hasKids ? open : undefined} aria-selected={target?.id === c.id}
                    className={`${styles.row} ${target?.id === c.id ? styles.sel : ''} ${c.active ? '' : styles.inactive}`} style={{ paddingLeft: 8 + depth * 14 }}>
                    {hasKids
                      ? <button type="button" className={styles.tw} aria-label={open ? `${c.name} einklappen` : `${c.name} ausklappen`} onClick={() => toggle(c.id)}>{open ? '▾' : '▸'}</button>
                      : <span className={styles.tw} aria-hidden="true" />}
                    <button type="button" className={styles.pick}
                      onClick={() => onSelect({ kind: 'category', id: c.id, name: c.name, cmsPage: c.cmsPage, path: categoryPath(categories, c) })}>
                      <span className={styles.nm}>{c.name}</span>
                      {c.cmsPage && <span className={styles.tag} title={`Layout: ${c.cmsPage}`}>Layout</span>}
                    </button>
                  </li>
                ))}
                {all.length > rows.length && <li className={styles.note} role="none">{all.length - rows.length} weitere {noun.many}: Suche weiter eingrenzen.</li>}
              </ul>
            ))}

        {kind === 'product' && (products === null ? <div className={styles.note}>Lade …</div>
          : products.length === 0 ? <div className={styles.note}>Keine Treffer.</div>
            : (
              <ul className={styles.ul} aria-label="Produkte">
                {products.map(p => (
                  <li key={p.id} className={`${styles.row} ${target?.id === p.id ? styles.sel : ''}`}>
                    <button type="button" className={styles.pick} aria-current={target?.id === p.id ? 'true' : undefined}
                      onClick={() => onSelect({ kind: 'product', id: p.id, name: p.name, cmsPage: p.cmsPage, path: p.number })}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- Shop-Thumbnails */}
                      {p.img ? <img src={p.img} alt="" loading="lazy" /> : <span className={styles.noimg} aria-hidden="true" />}
                      <span className={styles.nm}>{p.name}</span>
                      {p.cmsPage && <span className={styles.tag}>Layout</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
      </div>
    </div>
  );
}
