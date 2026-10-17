import styles from './Spinner.module.css';

/** Small busy ring (same look as the chat's status line); decorative, the text next to it says what runs. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <i className={[styles.spinner, className].filter(Boolean).join(' ')} style={{ width: size, height: size }} aria-hidden="true" />;
}
