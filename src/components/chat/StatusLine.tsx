import styles from './StatusLine.module.css';

/** „Lotse denkt nach …“ – Statuspille unter dem Verlauf. */
export function StatusLine({ text }: { text: string | null }) {
  return (
    <div className={styles.status} role="status" aria-live="polite" hidden={!text}>
      <i aria-hidden="true" /><span>{text}</span>
    </div>
  );
}
