'use client';

import { Fragment, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { Styleguide } from '@/lib/protocol';
import type { KnowledgeRule } from '@/lib/knowledge';
import { useT } from '@/lib/i18n/I18nProvider';
import { RulesEditor } from '@/components/knowledge/RulesEditor';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import styles from './dialogs.module.css';

interface Props { sg: Styleguide | null; open: boolean; onClose: () => void; onSaved: (sg: Styleguide) => void; onReanalyze: () => void }

const HEX6 = /^#[0-9a-f]{6}$/i;

/** Ohne Styleguide bleiben die Regeln erreichbar; Farben und Ton entstehen durch die Analyse des Shops. */
function NoStyleguide() {
  const t = useT().dialogs.styleguide;
  return (
    <>
      <div className={styles.sec}>
        <p className={styles.summary}>{t.none}</p>
      </div>
      <RulesSection />
    </>
  );
}

/** Styleguide ansehen; Farben direkt anpassen; neu analysieren lassen. */
export function StyleguideDialog({ sg, open, onClose, onSaved, onReanalyze }: Props) {
  const t = useT().dialogs.styleguide;
  return (
    <Dialog open={open} onClose={onClose} title={t.title}
      footer={sg
        ? <Footer key={sg.updatedAt ?? 'sg'} sg={sg} onClose={onClose} onSaved={onSaved} onReanalyze={onReanalyze} />
        : <Button variant="primary" onClick={() => { onClose(); onReanalyze(); }}>{t.analyze}</Button>}>
      {sg ? <Body sg={sg} /> : <NoStyleguide />}
    </Dialog>
  );
}

// Farbeingaben leben im Formular (form="sg-colors"); gespeichert wird beim Absenden im Footer.
function Body({ sg }: { sg: Styleguide }) {
  const c = (sg.colors ?? {}) as Record<string, string | undefined>;
  const tx = useT().dialogs.styleguide;
  const t = sg.typography ?? {};
  const s = sg.shape ?? {};
  const tone = sg.tone ?? { formality: '', voice: '', dos: [], donts: [], examples: [] };
  return (
    <>
      <div className={styles.sec}>
        <b className={styles.brand}>{sg.brandName}</b>
        <p className={styles.summary}>{sg.summary}</p>
      </div>
      <div className={styles.sec}>
        <h3>{tx.colors}</h3>
        <div className={styles.sws}>
          {Object.entries(c).filter((e): e is [string, string] => typeof e[1] === 'string' && HEX6.test(e[1])).map(([k, v]) => (
            <ColorSwatch key={k} name={k} initial={v} />
          ))}
        </div>
      </div>
      <div className={styles.sec}>
        <h3>{tx.typography}</h3>
        <dl className={styles.kv}>
          <dt>{tx.headings}</dt><dd>{t.headingFont}</dd>
          <dt>{tx.body}</dt><dd>{t.bodyFont}</dd>
          <dt>{tx.radius}</dt><dd>{s.radius}</dd>
          <dt>{tx.buttons}</dt><dd>{s.buttons}</dd>
          <dt>{tx.imagery}</dt><dd>{sg.imagery}</dd>
        </dl>
      </div>
      <div className={styles.sec}>
        <h3>{tx.tone} · {tone.formality}</h3>
        <p className={styles.voice}>{tone.voice}</p>
        <div className={styles.pills}>
          {(tone.dos ?? []).map(x => <span key={`d${x}`}>✓ {x}</span>)}
          {(tone.donts ?? []).map(x => <span key={`n${x}`}>✗ {x}</span>)}
        </div>
        {(tone.examples ?? []).map(x => <p key={x} className={styles.example}>{tx.quote(x)}</p>)}
      </div>
      <RulesSection />
      {(sg.components || sg.existingBlocks?.length) && <Blocks sg={sg} />}
      <p className={styles.note}>{tx.chatNote}</p>
    </>
  );
}

/** Eigene Regeln (dieselben wie auf der Seite Wissen): feste Vorgaben für Texte, je Bereich oder Kategorie. */
function RulesSection() {
  const t = useT().dialogs.styleguide;
  const [rules, setRules] = useState<KnowledgeRule[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.knowledge.list().then(r => setRules(r.rules)).catch(e => setErr(errorText(e))); }, []);
  return (
    <div className={styles.sec}>
      <h3>{t.rules}{rules?.length ? ` · ${rules.length}` : ''}</h3>
      <p className={styles.note}>{t.rulesNote}</p>
      {err && <p className={styles.err} role="alert">{err}</p>}
      {rules && <RulesEditor rules={rules} setRules={setRules as React.Dispatch<React.SetStateAction<KnowledgeRule[]>>} />}
    </div>
  );
}

const SHORT = 32;

/** Vom Shop erkannte Bausteine: kurze Namen als Chips, lange Beobachtungen als lesbare Liste. Standardmäßig eingeklappt, das ist Material für die KI. */
function Blocks({ sg }: { sg: Styleguide }) {
  const t = useT().dialogs.styleguide;
  const blocks = sg.existingBlocks ?? [], short = blocks.filter(x => x.length <= SHORT), long = blocks.filter(x => x.length > SHORT);
  const comps = Object.entries(sg.components ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1]);
  return (
    <details className={styles.blocks}>
      <summary><span>{t.blocks}</span><small>{t.blocksCount(comps.length + blocks.length)}</small></summary>
      {comps.length > 0 && (
        <dl className={styles.kv}>
          {comps.map(([k, v]) => <Fragment key={k}><dt>{t.componentLabel[k] ?? k}</dt><dd>{v}</dd></Fragment>)}
        </dl>
      )}
      {short.length > 0 && <div className={styles.pills}>{short.map(x => <span key={x}>{x}</span>)}</div>}
      {long.length > 0 && <ul className={styles.obs}>{long.map(x => <li key={x}>{x}</li>)}</ul>}
    </details>
  );
}

function ColorSwatch({ name, initial }: { name: string; initial: string }) {
  const [v, setV] = useState(initial);
  const t = useT().dialogs.styleguide;
  return (
    <label className={styles.swc}>
      <input type="color" name={name} form="sg-colors" value={v} onChange={e => setV(e.target.value)} />
      <div>{t.colorLabel[name] ?? name}<small>{v}</small></div>
    </label>
  );
}

function Footer({ sg, onClose, onSaved, onReanalyze }: { sg: Styleguide; onClose: () => void; onSaved: (sg: Styleguide) => void; onReanalyze: () => void }) {
  const [saving, setSaving] = useState(false);
  const t = useT().dialogs.styleguide;
  const [error, setError] = useState<string | null>(null);
  const save = async (form: HTMLFormElement) => {
    const colors = { ...sg.colors } as Record<string, string>;
    for (const el of Array.from(form.elements)) if (el instanceof HTMLInputElement && el.type === 'color') colors[el.name] = el.value;
    setSaving(true); setError(null);
    try { onSaved(await api.saveStyleguide({ ...sg, colors: colors as Styleguide['colors'] })); onClose(); }
    catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  };
  return (
    <form id="sg-colors" className={styles.footer} onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }}>
      {error && <span className={styles.err} role="alert">{error}</span>}
      <Button onClick={() => { onClose(); onReanalyze(); }}>{t.reanalyze}</Button>
      <Button type="submit" variant="primary" busy={saving}>{t.saveColors}</Button>
    </form>
  );
}
