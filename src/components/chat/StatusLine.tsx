import styles from './StatusLine.module.css';

/** "Lotse denkt nach ..." (Lotse is thinking): status pill below the history. */
export function StatusLine({ text }: { text: string | null }) {
  return (
    <div className={styles.status} role="status" aria-live="polite" hidden={!text}>
      <i aria-hidden="true" /><span>{text}</span>
    </div>
  );
}
