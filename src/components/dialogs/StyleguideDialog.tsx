'use client';

import { Fragment, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { Styleguide } from '@/lib/protocol';
import type { KnowledgeRule } from '@/lib/knowledge';
import { RulesEditor } from '@/components/knowledge/RulesEditor';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import styles from './dialogs.module.css';

interface Props { sg: Styleguide | null; open: boolean; onClose: () => void; onSaved: (sg: Styleguide) => void; onReanalyze: () => void }

const HEX6 = /^#[0-9a-f]{6}$/i;

/** Styleguide ansehen; Farben direkt anpassen; neu analysieren lassen. */
export function StyleguideDialog({ sg, open, onClose, onSaved, onReanalyze }: Props) {
  return (
    <Dialog open={open && !!sg} onClose={onClose} title="Styleguide"
      footer={sg && <Footer key={sg.updatedAt ?? 'sg'} sg={sg} onClose={onClose} onSaved={onSaved} onReanalyze={onReanalyze} />}>
      {sg && <Body sg={sg} />}
    </Dialog>
  );
}

const COLOR_LABEL: Record<string, string> = { primary: 'Primär', primaryContrast: 'Text auf Primär', secondary: 'Sekundär', accent: 'Akzent', text: 'Text', muted: 'Text gedämpft', background: 'Hintergrund', surface: 'Fläche', border: 'Rahmen' };

// Farbeingaben leben im Formular (form="sg-colors"); gespeichert wird beim Absenden im Footer.
function Body({ sg }: { sg: Styleguide }) {
  const c = (sg.colors ?? {}) as Record<string, string | undefined>;
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
        <h3>Farben (editierbar)</h3>
        <div className={styles.sws}>
          {Object.entries(c).filter((e): e is [string, string] => typeof e[1] === 'string' && HEX6.test(e[1])).map(([k, v]) => (
            <ColorSwatch key={k} name={k} initial={v} />
          ))}
        </div>
      </div>
      <div className={styles.sec}>
        <h3>Typografie &amp; Form</h3>
        <dl className={styles.kv}>
          <dt>Überschriften</dt><dd>{t.headingFont}</dd>
          <dt>Fließtext</dt><dd>{t.bodyFont}</dd>
          <dt>Radius</dt><dd>{s.radius}</dd>
          <dt>Buttons</dt><dd>{s.buttons}</dd>
          <dt>Bilder</dt><dd>{sg.imagery}</dd>
        </dl>
      </div>
      <div className={styles.sec}>
        <h3>Tonalität · {tone.formality}</h3>
        <p className={styles.voice}>{tone.voice}</p>
        <div className={styles.pills}>
          {(tone.dos ?? []).map(x => <span key={`d${x}`}>✓ {x}</span>)}
          {(tone.donts ?? []).map(x => <span key={`n${x}`}>✗ {x}</span>)}
        </div>
        {(tone.examples ?? []).map(x => <p key={x} className={styles.example}>„{x}“</p>)}
      </div>
      {(sg.components || sg.existingBlocks?.length) && (
        <div className={styles.sec}>
          <h3>Bausteine des Shops</h3>
          <dl className={styles.kv}>
            {Object.entries(sg.components ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1]).map(([k, v]) => (
              <Fragment key={k}><dt>{({ buttons: 'Buttons', headings: 'Überschriften', cards: 'Karten', sections: 'Abschnitte', notes: 'Hinweise' } as Record<string, string>)[k] ?? k}</dt><dd>{v}</dd></Fragment>
            ))}
          </dl>
          <div className={styles.pills}>{(sg.existingBlocks ?? []).map(x => <span key={x}>{x}</span>)}</div>
        </div>
      )}
      <RulesSection />
      <p className={styles.note}>Alles Weitere änderst du per Chat („Setze die Ansprache auf Du …“). Lotse aktualisiert dann den Styleguide.</p>
    </>
  );
}

/** Eigene Regeln (dieselben wie auf der Seite Wissen): feste Vorgaben für Texte, je Bereich oder Kategorie. */
function RulesSection() {
  const [rules, setRules] = useState<KnowledgeRule[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.knowledge.list().then(r => setRules(r.rules)).catch(e => setErr(errorText(e))); }, []);
  return (
    <div className={styles.sec}>
      <h3>Eigene Regeln{rules?.length ? ` · ${rules.length}` : ''}</h3>
      <p className={styles.note}>Feste Vorgaben für Texte, z. B. Mindestlänge, Wortwahl oder Besonderheiten einer Kategorie. Sie gelten in jedem Chat zusätzlich zum Styleguide.</p>
      {err && <p className={styles.err} role="alert">{err}</p>}
      {rules && <RulesEditor rules={rules} setRules={setRules as React.Dispatch<React.SetStateAction<KnowledgeRule[]>>} />}
    </div>
  );
}

function ColorSwatch({ name, initial }: { name: string; initial: string }) {
  const [v, setV] = useState(initial);
  return (
    <label className={styles.swc}>
      <input type="color" name={name} form="sg-colors" value={v} onChange={e => setV(e.target.value)} />
      <div>{COLOR_LABEL[name] ?? name}<small>{v}</small></div>
    </label>
  );
}

function Footer({ sg, onClose, onSaved, onReanalyze }: { sg: Styleguide; onClose: () => void; onSaved: (sg: Styleguide) => void; onReanalyze: () => void }) {
  const [saving, setSaving] = useState(false);
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
      <Button onClick={() => { onClose(); onReanalyze(); }}>Neu analysieren (neuer Chat)</Button>
      <Button type="submit" variant="primary" busy={saving}>Farben speichern</Button>
    </form>
  );
}
