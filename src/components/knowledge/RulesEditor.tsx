'use client';

import { useMemo, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { RULE_MAX, RULE_SCOPES, ruleScopeLabel, type KnowledgeRule, type RuleScope, type RuleTarget } from '@/lib/knowledge';
import type { CategoryRow } from '@/lib/protocol';
import { INTL_LOCALE } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import { IconEdit, IconTrash } from '@/components/ui/icons';
import styles from './Knowledge.module.css';

const kapi = api.knowledge;
const SCOPES = Object.keys(RULE_SCOPES) as RuleScope[];

/** Kategorien als flache Liste mit Pfad („Outdoor › Zelte“), sortiert; für die Begrenzung einer Regel auf eine Kategorie. */
function useCategoryOptions() {
  const [cats, setCats] = useState<CategoryRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { locale } = useI18n();
  const load = () => { if (cats || failed) return; api.categories().then(setCats).catch(() => setFailed(true)); };
  const options = useMemo(() => {
    const byId = new Map((cats ?? []).map(c => [c.id, c]));
    const path = (c: CategoryRow): string => { const out: string[] = []; for (let n: CategoryRow | undefined = c, i = 0; n && i < 8; n = n.parentId ? byId.get(n.parentId) : undefined, i++) out.unshift(n.name); return out.join(' › '); };
    return (cats ?? []).filter(c => c.name).map(c => ({ id: c.id, name: c.name, label: path(c) })).sort((a, b) => a.label.localeCompare(b.label, INTL_LOCALE[locale]));
  }, [cats, locale]);
  return { options, load, failed };
}

/** Auswahl „Gilt für“: Bereich + optional eine Kategorie. Kategorien werden erst beim Öffnen geladen. */
function ScopePicker({ scope, setScope, target, setTarget }: { scope: RuleScope; setScope: (s: RuleScope) => void; target: RuleTarget | null; setTarget: (t: RuleTarget | null) => void }) {
  const { options, load, failed } = useCategoryOptions();
  const known = target && options.some(o => o.id === target.id);
  const { locale, t: { knowledge: { editor: t } } } = useI18n();
  return (
    <>
      <select value={scope} onChange={e => setScope(e.target.value as RuleScope)} aria-label={t.appliesTo}>{SCOPES.map(k => <option key={k} value={k}>{t.appliesToOption(ruleScopeLabel(k, locale))}</option>)}</select>
      <select value={target?.id ?? ''} aria-label={t.category} onFocus={load} onMouseEnter={load}
        onChange={e => { const o = options.find(x => x.id === e.target.value); setTarget(o ? { id: o.id, name: o.name } : null); }}>
        <option value="">{t.wholeShop}</option>
        {target && !known && <option value={target.id}>{t.categoryOption(target.name)}</option>}
        {options.map(o => <option key={o.id} value={o.id}>{t.onlyCategory(o.label)}</option>)}
        {failed && <option disabled>{t.categoriesFailed}</option>}
      </select>
    </>
  );
}

/** Eigene Regeln: Formular zum Anlegen und Liste zum Bearbeiten; geteilt von Wissen-Seite und Styleguide-Dialog. */
export function RulesEditor({ rules, setRules }: { rules: KnowledgeRule[]; setRules: React.Dispatch<React.SetStateAction<KnowledgeRule[]>> }) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<RuleScope>('all');
  const [target, setTarget] = useState<RuleTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = useI18n().t.knowledge.editor;
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); if (!text.trim()) return;
    setBusy(true); setErr(null);
    try { const r = await kapi.addRule(text, scope, target); setRules(rs => [...rs, r]); setText(''); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  };
  return (
    <>
      <form className={styles.ruleForm} onSubmit={add}>
        <textarea value={text} onChange={e => setText(e.target.value)} maxLength={RULE_MAX} rows={2} placeholder={t.placeholder} aria-label={t.newRule} />
        <div className={styles.ruleBar}>
          <ScopePicker scope={scope} setScope={setScope} target={target} setTarget={setTarget} />
          <small className={styles.muted}>{text.length}/{RULE_MAX}</small>
          <Button type="submit" variant="primary" busy={busy} disabled={!text.trim()}>{t.add}</Button>
        </div>
        {err && <p className={styles.err}>{err}</p>}
      </form>
      {rules.length === 0 ? <p className={styles.empty}>{t.empty}</p> : (
        <ul className={styles.rules}>{rules.map(r => <RuleRow key={r.id} rule={r} onSave={n => setRules(rs => rs.map(x => (x.id === n.id ? n : x)))} onDelete={() => setRules(rs => rs.filter(x => x.id !== r.id))} />)}</ul>
      )}
    </>
  );
}

function RuleRow({ rule, onSave, onDelete }: { rule: KnowledgeRule; onSave: (r: KnowledgeRule) => void; onDelete: () => void }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const [text, setText] = useState(rule.text);
  const [scope, setScope] = useState<RuleScope>(rule.scope);
  const [target, setTarget] = useState<RuleTarget | null>(rule.target);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { locale, t: { common: c, knowledge: { editor: t } } } = useI18n();
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); } };

  if (mode === 'edit') return (
    <li className={styles.rule}>
      <form className={styles.ruleEdit} onSubmit={e => { e.preventDefault(); run(async () => { onSave(await kapi.saveRule(rule.id, text, scope, target)); setMode('view'); }); }}>
        <textarea value={text} onChange={e => setText(e.target.value)} maxLength={RULE_MAX} rows={2} aria-label={t.rule} autoFocus />
        <div className={styles.ruleBar}>
          <ScopePicker scope={scope} setScope={setScope} target={target} setTarget={setTarget} />
          <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!text.trim()}>{c.save}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setText(rule.text); setScope(rule.scope); setTarget(rule.target); setMode('view'); }}>{c.cancel}</Button>
        </div>
        {err && <p className={styles.err}>{err}</p>}
      </form>
    </li>
  );
  return (
    <li className={styles.rule}>
      <span className={`${styles.scope} ${styles['s_' + rule.scope]}`}>{ruleScopeLabel(rule.scope, locale)}</span>
      <p className={styles.ruleText}>{rule.text}{rule.target && <small className={styles.muted}>{t.onlyCategoryNote(rule.target.name)}</small>}</p>
      <div className={styles.actions}>
        {mode === 'confirm' ? (
          <>
            <Button size="sm" variant="danger" busy={busy} onClick={() => run(async () => { await kapi.deleteRule(rule.id); onDelete(); })} autoFocus>{c.delete}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('view')}>{c.cancel}</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setMode('edit')} aria-label={t.edit} title={t.editTitle}><IconEdit size={15} /></Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('confirm')} aria-label={t.remove} title={c.delete}><IconTrash size={15} /></Button>
          </>
        )}
      </div>
      {err && <p className={styles.err}>{err}</p>}
    </li>
  );
}
