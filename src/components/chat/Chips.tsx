import { useT } from '@/lib/i18n/I18nProvider';
import styles from './Chips.module.css';

/** Vorschläge passend zum gewählten Kontext. */
export function Chips({ items, onPick }: { items: string[]; onPick: (s: string) => void }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <div className={styles.chips} role="group" aria-label={t.chat.suggestionsAria}>
      {items.map(s => <button key={s} type="button" onClick={() => onPick(s)}>{s}</button>)}
    </div>
  );
}
