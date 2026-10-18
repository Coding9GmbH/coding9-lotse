import styles from './Sandbox.module.css';

/** Plain words first, the technical term as small secondary text ("Gespeicherte Schritte · Commits"): shop operators read the first,
 *  developers recognise the second. */
export function Term({ children, tech }: { children: React.ReactNode; tech: string }) {
  return <>{children} <small className={styles.tech}>{tech}</small></>;
}
