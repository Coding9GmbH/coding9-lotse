import { kindLabel } from '@/lib/labels';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { AppConfig, Target } from '@/lib/protocol';
import { adminUrl, storefrontUrl } from '@/lib/urls';
import styles from './TargetCard.module.css';

/** Gewählter Kontext mit Links in Admin und Storefront. */
export function TargetCard({ target: t, cfg, onClear }: { target: Target; cfg: AppConfig | null; onClear: () => void }) {
  const { locale, t: m } = useI18n(), tx = m.chat.target;
  const landing = t.kind === 'landing';
  return (
    <section className={styles.target} aria-label={tx.aria}>
      <button type="button" className={styles.x} title={tx.remove} aria-label={tx.remove} onClick={onClear}>×</button>
      <div className={styles.k}>{kindLabel(t.kind, locale)}</div>
      <div className={styles.n}>{t.name}</div>
      <div className={styles.m}>
        {landing ? tx.landing : `${t.path ?? ''}${t.cmsPage ? tx.layout(t.cmsPage) : tx.noLayout}`}
      </div>
      {!landing && t.id && cfg && (
        <div className={styles.links}>
          <a target="_blank" rel="noopener noreferrer" href={adminUrl(cfg, t.kind === 'category' ? 'category' : 'product', t.id)}>{tx.openAdmin}</a>
          <a target="_blank" rel="noopener noreferrer" href={storefrontUrl(cfg, t)}>{tx.viewInShop}</a>
        </div>
      )}
    </section>
  );
}
