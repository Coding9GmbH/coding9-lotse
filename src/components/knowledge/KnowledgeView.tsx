'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { KNOWLEDGE_LEAD, RULE_MAX, RULE_SCOPES, type KnowledgeDoc, type KnowledgeLink, type KnowledgeRule, type RuleScope } from '@/lib/knowledge';
import type { ProductRow } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { IconClose, IconEdit, IconSearch, IconTrash, IconUpload } from '@/components/ui/icons';
import styles from './Knowledge.module.css';

const ACCEPT = '.pdf,.docx,.xlsx,.csv,.tsv,.txt,.md,.json';
const kapi = api.knowledge;

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const typeOf = (d: KnowledgeDoc) => (d.fileName?.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'txt').toUpperCase();
const SOURCE: Record<KnowledgeDoc['source'], string> = { upload: 'hochgeladen', chat: 'aus dem Chat', text: 'Notiz aus dem Chat' };
const SCOPES = Object.entries(RULE_SCOPES) as [RuleScope, string][];

interface Job { name: string; error?: string }

/** Wissensbasis: Dokumente (Datenblätter, PDFs …) als Faktenquelle und eigene Regeln des Shops. */
export function KnowledgeView() {
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [rules, setRules] = useState<KnowledgeRule[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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
        <h1 className={styles.h1}>Wissen</h1>
        <p className={styles.lead}>{KNOWLEDGE_LEAD}</p>
        {loadError && <p className={styles.alert}>Wissensbasis konnte nicht geladen werden: {loadError}</p>}

        <section className={styles.card} aria-labelledby="k-docs">
          <div className={styles.cardHead}><h2 id="k-docs">Dokumente</h2>{!!docs?.length && <span className={styles.count}>{docs.length}</span>}</div>
          <div className={`${styles.drop} ${drag ? styles.dropActive : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
            onClick={() => fileRef.current?.click()} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}>
            <IconUpload size={22} />
            <span><b>Dateien hierher ziehen</b> oder klicken zum Auswählen</span>
            <small>PDF, Word (.docx), Excel (.xlsx), CSV, Text, Markdown, JSON · bis 25 MB · keine Kunden- oder Bestelldaten</small>
            <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={e => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) upload(fs); }} />
          </div>
          {jobs.length > 0 && (
            <ul className={styles.jobs}>
              {jobs.map(j => (
                <li key={j.name} className={j.error ? styles.jobErr : undefined}>
                  {j.error ? <span><b>{j.name}:</b> {j.error}</span> : <><i className={styles.spin} aria-hidden="true" /><span>Lese {j.name} …</span></>}
                  {j.error && <button type="button" className={styles.x} aria-label="Meldung schließen" onClick={() => setJobs(js => js.filter(x => x.name !== j.name))}><IconClose size={14} /></button>}
                </li>
              ))}
            </ul>
          )}
          {docs === null && !loadError && <p className={styles.muted}>Lade …</p>}
          {docs?.length === 0 && <p className={styles.empty}>Noch keine Dokumente. Lade ein Datenblatt hoch oder hänge es im Chat an und sag „Nimm das in die Wissensbasis auf“.</p>}
          {!!docs?.length && <ul className={styles.docs}>{docs.map(d => <DocRow key={d.id} doc={d} onChange={replace} onDelete={() => setDocs(ds => ds?.filter(x => x.id !== d.id) ?? null)} />)}</ul>}
        </section>

        <RulesCard rules={rules} setRules={setRules} />
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
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); } };
  const setLinks = (links: KnowledgeLink[]) => run(async () => onChange(await kapi.patchDoc(doc.id, { links })));
  const meta = [typeOf(doc), doc.pages ? `${doc.pages} ${doc.pages === 1 ? 'Seite' : 'Seiten'}` : null, `${doc.chunks} ${doc.chunks === 1 ? 'Abschnitt' : 'Abschnitte'}`, fmtSize(doc.size), `${SOURCE[doc.source]} am ${fmtDate(doc.createdAt)}`].filter(Boolean).join(' · ');

  return (
    <li className={styles.doc}>
      <span className={styles.type} aria-hidden="true">{typeOf(doc)}</span>
      <div className={styles.docMain}>
        {mode === 'rename' ? (
          <form className={styles.inline} onSubmit={e => { e.preventDefault(); run(async () => { onChange(await kapi.patchDoc(doc.id, { title })); setMode('view'); }); }}>
            <input value={title} onChange={e => setTitle(e.target.value)} maxLength={160} aria-label="Titel" autoFocus />
            <Button type="submit" size="sm" variant="primary" busy={busy}>Speichern</Button>
            <Button size="sm" variant="ghost" onClick={() => { setTitle(doc.title); setMode('view'); }}>Abbrechen</Button>
          </form>
        ) : <b className={styles.docTitle}>{doc.title}</b>}
        <small className={styles.meta}>{meta}</small>
        {(doc.links.length > 0 || doc.tags.length > 0) && (
          <div className={styles.chips}>
            {doc.links.map(l => (
              <span key={l.kind + l.id} className={styles.chip} title={l.kind === 'product' ? 'Verknüpftes Produkt' : 'Verknüpfte Kategorie'}>
                <span className={styles.chipName}>{l.kind === 'category' && 'Kategorie '}{l.name ?? l.id}</span>{l.number && <em>{l.number}</em>}
                {unlink === l.kind + l.id ? (
                  <>
                    <span className={styles.confirmText}>Löschen?</span>
                    <Button size="sm" variant="danger" busy={busy} onClick={() => { setUnlink(null); setLinks(doc.links.filter(x => x !== l)); }}>Löschen</Button>
                    <Button size="sm" variant="ghost" onClick={() => setUnlink(null)}>Abbrechen</Button>
                  </>
                ) : (
                  <button type="button" aria-label={`Verknüpfung mit ${l.name ?? l.id} lösen`} disabled={busy} onClick={() => setUnlink(l.kind + l.id)}><IconClose size={12} /></button>
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
            <span className={styles.confirmText}>Löschen?</span>
            <Button size="sm" variant="danger" busy={busy} onClick={() => run(async () => { await kapi.deleteDoc(doc.id); onDelete(); })} autoFocus>Löschen</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('view')}>Abbrechen</Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={() => setMode(mode === 'link' ? 'view' : 'link')} aria-expanded={mode === 'link'}>Produkt verknüpfen</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('rename')} aria-label={`„${doc.title}“ umbenennen`} title="Umbenennen"><IconEdit size={15} /></Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('confirm')} aria-label={`„${doc.title}“ löschen`} title="Löschen"><IconTrash size={15} /></Button>
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
  const q = term.trim();
  const rows = q.length >= 2 && found?.term === q ? found.rows : null;
  const loading = q.length >= 2 && !rows && !err;
  useEffect(() => {
    if (q.length < 2) return;
    let off = false;
    const t = setTimeout(() => api.products(q).then(r => { if (!off) { setFound({ term: q, rows: r }); setErr(null); } }).catch(e => { if (!off) setErr(errorText(e)); }), 250);
    return () => { off = true; clearTimeout(t); };
  }, [q]);
  return (
    <div className={styles.picker}>
      <label className={styles.search}>
        <IconSearch size={15} />
        <input type="search" value={term} onChange={e => setTerm(e.target.value)} placeholder="Produkt suchen (Name oder Artikelnummer)" aria-label="Produkt suchen" autoFocus onKeyDown={e => { if (e.key === 'Escape') onClose(); }} />
      </label>
      {err && <p className={styles.err}>{err}</p>}
      {loading && <p className={styles.muted}>Suche …</p>}
      {rows && rows.length === 0 && <p className={styles.muted}>Kein Produkt gefunden.</p>}
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
                  {linked && <em>verknüpft</em>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RulesCard({ rules, setRules }: { rules: KnowledgeRule[]; setRules: React.Dispatch<React.SetStateAction<KnowledgeRule[]>> }) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<RuleScope>('all');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); if (!text.trim()) return;
    setBusy(true); setErr(null);
    try { const r = await kapi.addRule(text, scope); setRules(rs => [...rs, r]); setText(''); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  };
  return (
    <section className={styles.card} aria-labelledby="k-rules">
      <div className={styles.cardHead}><h2 id="k-rules">Eigene Regeln</h2>{rules.length > 0 && <span className={styles.count}>{rules.length}</span>}</div>
      <p className={styles.hint}>Kurze, feste Vorgaben für alle Texte, z. B. Wortwahl, Ansprache oder Schreibweisen. Sie gelten in jedem Chat zusätzlich zum Styleguide.</p>
      <form className={styles.ruleForm} onSubmit={add}>
        <textarea value={text} onChange={e => setText(e.target.value)} maxLength={RULE_MAX} rows={2} placeholder="z. B. Wir sagen nie „günstig“, sondern „fair kalkuliert“." aria-label="Neue Regel" />
        <div className={styles.ruleBar}>
          <select value={scope} onChange={e => setScope(e.target.value as RuleScope)} aria-label="Gilt für">{SCOPES.map(([k, v]) => <option key={k} value={k}>Gilt für: {v}</option>)}</select>
          <small className={styles.muted}>{text.length}/{RULE_MAX}</small>
          <Button type="submit" variant="primary" busy={busy} disabled={!text.trim()}>Regel hinzufügen</Button>
        </div>
        {err && <p className={styles.err}>{err}</p>}
      </form>
      {rules.length === 0 ? <p className={styles.empty}>Noch keine Regeln. Du kannst sie auch im Chat festlegen: „Merk dir: wir duzen unsere Kunden“.</p> : (
        <ul className={styles.rules}>{rules.map(r => <RuleRow key={r.id} rule={r} onSave={n => setRules(rs => rs.map(x => (x.id === n.id ? n : x)))} onDelete={() => setRules(rs => rs.filter(x => x.id !== r.id))} />)}</ul>
      )}
    </section>
  );
}

function RuleRow({ rule, onSave, onDelete }: { rule: KnowledgeRule; onSave: (r: KnowledgeRule) => void; onDelete: () => void }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const [text, setText] = useState(rule.text);
  const [scope, setScope] = useState<RuleScope>(rule.scope);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); } };

  if (mode === 'edit') return (
    <li className={styles.rule}>
      <form className={styles.ruleEdit} onSubmit={e => { e.preventDefault(); run(async () => { onSave(await kapi.saveRule(rule.id, text, scope)); setMode('view'); }); }}>
        <textarea value={text} onChange={e => setText(e.target.value)} maxLength={RULE_MAX} rows={2} aria-label="Regel" autoFocus />
        <div className={styles.ruleBar}>
          <select value={scope} onChange={e => setScope(e.target.value as RuleScope)} aria-label="Gilt für">{SCOPES.map(([k, v]) => <option key={k} value={k}>Gilt für: {v}</option>)}</select>
          <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!text.trim()}>Speichern</Button>
          <Button size="sm" variant="ghost" onClick={() => { setText(rule.text); setScope(rule.scope); setMode('view'); }}>Abbrechen</Button>
        </div>
        {err && <p className={styles.err}>{err}</p>}
      </form>
    </li>
  );
  return (
    <li className={styles.rule}>
      <span className={`${styles.scope} ${styles['s_' + rule.scope]}`}>{RULE_SCOPES[rule.scope]}</span>
      <p className={styles.ruleText}>{rule.text}</p>
      <div className={styles.actions}>
        {mode === 'confirm' ? (
          <>
            <Button size="sm" variant="danger" busy={busy} onClick={() => run(async () => { await kapi.deleteRule(rule.id); onDelete(); })} autoFocus>Löschen</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('view')}>Abbrechen</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setMode('edit')} aria-label="Regel bearbeiten" title="Bearbeiten"><IconEdit size={15} /></Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('confirm')} aria-label="Regel löschen" title="Löschen"><IconTrash size={15} /></Button>
          </>
        )}
      </div>
      {err && <p className={styles.err}>{err}</p>}
    </li>
  );
}
