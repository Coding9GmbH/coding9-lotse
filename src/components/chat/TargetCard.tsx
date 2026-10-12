import { KIND_LABEL } from '@/lib/labels';
import type { AppConfig, Target } from '@/lib/protocol';
import { adminUrl, storefrontUrl } from '@/lib/urls';
import styles from './TargetCard.module.css';

/** Gewählter Kontext mit Links in Admin und Storefront. */
export function TargetCard({ target: t, cfg, onClear }: { target: Target; cfg: AppConfig | null; onClear: () => void }) {
  const landing = t.kind === 'landing';
  return (
    <section className={styles.target} aria-label="Kontext">
      <button type="button" className={styles.x} title="Kontext entfernen" aria-label="Kontext entfernen" onClick={onClear}>×</button>
      <div className={styles.k}>{KIND_LABEL[t.kind]}</div>
      <div className={styles.n}>{t.name}</div>
      <div className={styles.m}>
        {landing ? 'Eigene URL, wird beim Veröffentlichen festgelegt' : `${t.path ?? ''}${t.cmsPage ? ` · Layout: ${t.cmsPage}` : ' · noch ohne eigenes Layout'}`}
      </div>
      {!landing && t.id && cfg && (
        <div className={styles.links}>
          <a target="_blank" rel="noopener noreferrer" href={adminUrl(cfg, t.kind === 'category' ? 'category' : 'product', t.id)}>Im Admin öffnen ↗</a>
          <a target="_blank" rel="noopener noreferrer" href={storefrontUrl(cfg, t)}>Storefront ↗</a>
        </div>
      )}
    </section>
  );
}
