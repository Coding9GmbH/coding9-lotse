import styles from './Segmented.module.css';

export interface SegOption<T extends string> { value: T; label: React.ReactNode; title?: string }
interface Props<T extends string> { options: SegOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string }

/** Segmented switch (category/product/landing page, current/draft/JSON …); arrow keys switch as in radio groups. */
export function Segmented<T extends string>({ options, value, onChange, label, className }: Props<T>) {
  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (idx + d + options.length) % options.length;
    onChange(options[j].value);
    e.currentTarget.parentElement?.querySelectorAll('button')[j]?.focus();
  };
  return (
    <div className={[styles.seg, className].filter(Boolean).join(' ')} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} title={o.title} tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? styles.on : undefined} onClick={() => onChange(o.value)} onKeyDown={e => onKey(e, i)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
