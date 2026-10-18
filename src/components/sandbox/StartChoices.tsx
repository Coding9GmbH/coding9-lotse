'use client';

import type { Messages } from '@/lib/i18n';
import type { LibraryDumpPublic, QuickStartPublic } from '@/lib/protocol';
import { choiceKey, orderedEnvironments, quickSummary, type StartChoice } from '@/lib/sandbox-task';
import type { MenuItem } from '@/components/ui/Menu';
import styles from './Sandbox.module.css';

/** What a saved environment uses, in one line (the stored database by its name, from the list of stored databases) */
export const envSummary = (q: QuickStartPublic, all: Messages, dumps: LibraryDumpPublic[] | null) => quickSummary(q.setup, all, id => dumps?.find(d => d.id === id)?.name);
const envLabel = (q: QuickStartPublic, all: Messages) => `${q.name}${q.default ? ` (${all.sandbox.quick.isDefault})` : ''}`;

/**
 * A23: the one choice list of every entry point, top to bottom – the saved environments (the default first), "Demo-Shop ohne Projekt"
 * (one click) and "Neu einrichten …" (the start dialog) – as menu items: the workspace's "Sandbox starten" and "Neue Sandbox" on the
 * Sandbox Coding page. `list` null: still loading. `manage`: a link to the saved environments at the end.
 */
export function startChoiceItems({ list, dumps, all, onPick, disabled = false, manage }: {
  list: QuickStartPublic[] | null; dumps: LibraryDumpPublic[] | null; all: Messages; onPick: (c: StartChoice) => void; disabled?: boolean; manage?: string;
}): MenuItem[] {
  const t = all.sandbox.quick;
  return [
    ...(list ? orderedEnvironments(list).map((q): MenuItem => ({ key: q.id, label: envLabel(q, all), description: envSummary(q, all, dumps), disabled, onSelect: () => onPick({ type: 'env', id: q.id }) }))
      : [{ key: 'loading', label: '…', disabled: true }]),
    { key: 'demo', label: t.demo, description: t.demoText, disabled, onSelect: () => onPick({ type: 'demo' }) },
    { key: 'new', label: t.setup, description: t.setupText, disabled, onSelect: () => onPick({ type: 'new' }) },
    ...(manage ? [{ key: 'manage', label: t.manage, href: manage }] : []),
  ];
}

/** The same list as radio buttons (the AI's card): the choice it suggested preselected, the user confirms or switches.
 *  `setupFor`: where "Neu einrichten …" starts (the AI's repository), shown in its label. */
export function StartChoiceRadios({ list, dumps, all, value, onChange, setupFor, name }: {
  list: QuickStartPublic[] | null; dumps: LibraryDumpPublic[] | null; all: Messages; value: StartChoice | null; onChange: (c: StartChoice) => void; setupFor?: string; name: string;
}) {
  const t = all.sandbox.quick, cur = value ? choiceKey(value) : null;
  const row = (c: StartChoice, label: string, text: string) => (
    <label key={choiceKey(c)} className={styles.kindCard}>
      <input type="radio" name={name} value={choiceKey(c)} checked={cur === choiceKey(c)} onChange={() => onChange(c)} />
      <span><b>{label}</b><small>{text}</small></span>
    </label>
  );
  return (
    <fieldset className={styles.kindList}>
      <legend>{t.choices}</legend>
      {list === null && <p className={styles.muted}>…</p>}
      {orderedEnvironments(list ?? []).map(q => row({ type: 'env', id: q.id }, envLabel(q, all), envSummary(q, all, dumps)))}
      {row({ type: 'demo' }, t.demo, t.demoText)}
      {row({ type: 'new' }, setupFor ? t.setupFor(setupFor) : t.setup, t.setupText)}
    </fieldset>
  );
}
