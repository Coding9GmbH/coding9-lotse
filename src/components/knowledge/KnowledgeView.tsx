'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { knowledgeLead, type KnowledgeDoc, type KnowledgeLink, type KnowledgeRule } from '@/lib/knowledge';
import type { ProductRow } from '@/lib/protocol';
import { formatNumber, INTL_LOCALE, type Locale } from '@/lib/i18n';
import { useI18n, useT } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import { IconClose, IconEdit, IconSearch, IconTrash, IconUpload } from '@/components/ui/icons';
import { useShell } from '@/components/shell/ShellProvider';
import styles from './Knowledge.module.css';

const ACCEPT = '.pdf,.docx,.xlsx,.csv,.tsv,.txt,.md,.json';
const kapi = api.knowledge;

const fmtSize = (n: number, locale: Locale) => (n >= 1024 * 1024 ? `${formatNumber(n / 1024 / 1024, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDate = (iso: string, locale: Locale) => new Date(iso).toLocaleDateString(INTL_LOCALE[locale], { day: '2-digit', month: '2-digit', year: 'numeric' });
const typeOf = (d: KnowledgeDoc) => (d.fileName?.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'txt').toUpperCase();

interface Job { name: string; error?: string }

/** Wissensbasis: Dokumente (Datenblätter, PDFs …) als Faktenquelle und eigene Regeln des Shops. */
export function KnowledgeView() {
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [rules, setRules] = useState<KnowledgeRule[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { locale, t: { knowledge: t } } = useI18n();

  const reload = useCallback(() => kapi.list().then(r => { setDocs(r.docs); setRules(r.rules); setLoadError(null); }).catch(e => setLoadError(errorText(e))), []);
  useEffect(() => { reload(); }, [reload]);

  const upload = async (files: File[]) => {
    for (const f of files) {
      setJobs(j => [...j.filter(x => x.name !== f.name), { name: f.name }]);
      try {
        const stored = await api.uploadFile(f);
        const doc = await kapi.addDoc(stored.fileId);
        setDocs(d => [doc, ...(d ?? [])]);
        setJobs(j => j.filter(x => x.name !== f.name));
      } catch (e) { setJobs(j => j.map(x => (x.name === f.name ? { ...x, error: errorText(e) } : x))); }
    }
  };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDrag(false); const fs = [...e.dataTransfer.files]; if (fs.length) upload(fs); };
  const replace = (doc: KnowledgeDoc) => setDocs(d => d?.map(x => (x.id === doc.id ? doc : x)) ?? null);

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <h1 className={styles.h1}>{t.title}</h1>
        <p className={styles.lead}>{knowledgeLead(locale)}</p>
        {loadError && <p className={styles.alert}>{t.loadFailed(loadError)}</p>}

        <section className={styles.card} aria-labelledby="k-docs">
          <div className={styles.cardHead}><h2 id="k-docs">{t.docs}</h2>{!!docs?.length && <span className={styles.count}>{docs.length}</span>}</div>
          <div className={`${styles.drop} ${drag ? styles.dropActive : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
            onClick={() => fileRef.current?.click()} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}>
            <IconUpload size={22} />
            <span><b>{t.dropStrong}</b>{t.dropRest}</span>
            <small>{t.dropHint}</small>
            <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={e => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) upload(fs); }} />
          </div>
          {jobs.length > 0 && (
            <ul className={styles.jobs}>
              {jobs.map(j => (
                <li key={j.name} className={j.error ? styles.jobErr : undefined}>
                  {j.error ? <span><b>{j.name}:</b> {j.error}</span> : <><i className={styles.spin} aria-hidden="true" /><span>{t.reading(j.name)}</span></>}
                  {j.error && <button type="button" className={styles.x} aria-label={t.dismiss} onClick={() => setJobs(js => js.filter(x => x.name !== j.name))}><IconClose size={14} /></button>}
                </li>
              ))}
            </ul>
          )}
          {docs === null && !loadError && <p className={styles.muted}>{t.loading}</p>}
          {docs?.length === 0 && <p className={styles.empty}>{t.emptyDocs}</p>}
          {!!docs?.length && <ul className={styles.docs}>{docs.map(d => <DocRow key={d.id} doc={d} onChange={replace} onDelete={() => setDocs(ds => ds?.filter(x => x.id !== d.id) ?? null)} />)}</ul>}
        </section>

        <RulesCard rules={rules} />
      </div>
    </div>
  );
}

function DocRow({ doc, onChange, onDelete }: { doc: KnowledgeDoc; onChange: (d: KnowledgeDoc) => void; onDelete: () => void }) {
  const [mode, setMode] = useState<'view' | 'rename' | 'link' | 'confirm'>('view');
  const [unlink, setUnlink] = useState<string | null>(null);
  const [title, setTitle] = useState(doc.title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { locale, t: { common: c, knowledge: t } } = useI18n();
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); } };
  const setLinks = (links: KnowledgeLink[]) => run(async () => onChange(await kapi.patchDoc(doc.id, { links })));
  const meta = [typeOf(doc), doc.pages ? t.pages(doc.pages) : null, t.chunks(doc.chunks), fmtSize(doc.size, locale), t.addedOn(t.source[doc.source], fmtDate(doc.createdAt, locale))].filter(Boolean).join(' · ');

  return (
    <li className={styles.doc}>
      <span className={styles.type} aria-hidden="true">{typeOf(doc)}</span>
      <div className={styles.docMain}>
        {mode === 'rename' ? (
          <form className={styles.inline} onSubmit={e => { e.preventDefault(); run(async () => { onChange(await kapi.patchDoc(doc.id, { title })); setMode('view'); }); }}>
            <input value={title} onChange={e => setTitle(e.target.value)} maxLength={160} aria-label={t.titleLabel} autoFocus />
            <Button type="submit" size="sm" variant="primary" busy={busy}>{c.save}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setTitle(doc.title); setMode('view'); }}>{c.cancel}</Button>
          </form>
        ) : <b className={styles.docTitle}>{doc.title}</b>}
        <small className={styles.meta}>{meta}</small>
        {(doc.links.length > 0 || doc.tags.length > 0) && (
          <div className={styles.chips}>
            {doc.links.map(l => (
              <span key={l.kind + l.id} className={styles.chip} title={l.kind === 'product' ? t.linkedProduct : t.linkedCategory}>
                <span className={styles.chipName}>{l.kind === 'category' && t.categoryPrefix}{l.name ?? l.id}</span>{l.number && <em>{l.number}</em>}
                {unlink === l.kind + l.id ? (
                  <>
                    <span className={styles.confirmText}>{t.confirmDelete}</span>
                    <Button size="sm" variant="danger" busy={busy} onClick={() => { setUnlink(null); setLinks(doc.links.filter(x => x !== l)); }}>{c.delete}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setUnlink(null)}>{c.cancel}</Button>
                  </>
                ) : (
                  <button type="button" aria-label={t.unlink(l.name ?? l.id)} disabled={busy} onClick={() => setUnlink(l.kind + l.id)}><IconClose size={12} /></button>
                )}
              </span>
            ))}
            {doc.tags.map(t => <span key={t} className={`${styles.chip} ${styles.tag}`}>#{t}</span>)}
          </div>
        )}
        {mode === 'link' && <ProductPicker exclude={doc.links.map(l => l.id)} onPick={p => setLinks([...doc.links, { kind: 'product', id: p.id, number: p.number, name: p.name }])} onClose={() => setMode('view')} />}
        {err && <p className={styles.err}>{err}</p>}
      </div>
      <div className={styles.actions}>
        {mode === 'confirm' ? (
          <>
            <span className={styles.confirmText}>{t.confirmDelete}</span>
            <Button size="sm" variant="danger" busy={busy} onClick={() => run(async () => { await kapi.deleteDoc(doc.id); onDelete(); })} autoFocus>{c.delete}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('view')}>{c.cancel}</Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={() => setMode(mode === 'link' ? 'view' : 'link')} aria-expanded={mode === 'link'}>{t.linkProduct}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('rename')} aria-label={t.renameDoc(doc.title)} title={t.rename}><IconEdit size={15} /></Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('confirm')} aria-label={t.deleteDoc(doc.title)} title={c.delete}><IconTrash size={15} /></Button>
          </>
        )}
      </div>
    </li>
  );
}

function ProductPicker({ exclude, onPick, onClose }: { exclude: string[]; onPick: (p: ProductRow) => void; onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<{ term: string; rows: ProductRow[] } | null>(null); // Treffer gehören zu genau einem Suchbegriff
  const [err, setErr] = useState<string | null>(null);
  const t = useT().knowledge;
  const q = term.trim();
  const rows = q.length >= 2 && found?.term === q ? found.rows : null;
  const loading = q.length >= 2 && !rows && !err;
  useEffect(() => {
    if (q.length < 2) return;
    let off = false;
    const timer = setTimeout(() => api.products(q).then(r => { if (!off) { setFound({ term: q, rows: r }); setErr(null); } }).catch(e => { if (!off) setErr(errorText(e)); }), 250);
    return () => { off = true; clearTimeout(timer); };
  }, [q]);
  return (
    <div className={styles.picker}>
      <label className={styles.search}>
        <IconSearch size={15} />
        <input type="search" value={term} onChange={e => setTerm(e.target.value)} placeholder={t.searchProduct} aria-label={t.searchProductLabel} autoFocus onKeyDown={e => { if (e.key === 'Escape') onClose(); }} />
      </label>
      {err && <p className={styles.err}>{err}</p>}
      {loading && <p className={styles.muted}>{t.searching}</p>}
      {rows && rows.length === 0 && <p className={styles.muted}>{t.noProduct}</p>}
      {rows && rows.length > 0 && (
        <ul className={styles.results}>
          {rows.slice(0, 8).map(p => {
            const linked = exclude.includes(p.id);
            return (
              <li key={p.id}>
                <button type="button" disabled={linked} onClick={() => onPick(p)}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- Shop-Bild */}
                  {p.img ? <img src={p.img} alt="" width={28} height={28} /> : <i className={styles.noImg} />}
                  <span>{p.name}<small>{p.number}</small></span>
                  {linked && <em>{t.linked}</em>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Regeln leben im Styleguide (Marke und Vorgaben an einem Ort); hier nur der Hinweis samt Weg dorthin. */
function RulesCard({ rules }: { rules: KnowledgeRule[] }) {
  const shell = useShell();
  const t = useT().knowledge;
  return (
    <section className={styles.card} aria-labelledby="k-rules">
      <div className={styles.cardHead}><h2 id="k-rules">{t.rules}</h2>{rules.length > 0 && <span className={styles.count}>{rules.length}</span>}</div>
      <p className={styles.hint}>{t.rulesHint}</p>
      <Button onClick={shell.nav.openRules}>{t.openRules}</Button>
    </section>
  );
}
