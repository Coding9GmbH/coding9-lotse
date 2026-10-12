import styles from './Chips.module.css';

/** Vorschläge passend zum gewählten Kontext. */
export function Chips({ items, onPick }: { items: string[]; onPick: (s: string) => void }) {
  if (!items.length) return null;
  return (
    <div className={styles.chips} role="group" aria-label="Vorschläge">
      {items.map(s => <button key={s} type="button" onClick={() => onPick(s)}>{s}</button>)}
    </div>
  );
}
