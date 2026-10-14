'use client';

import type { Target } from '@/lib/protocol';
import { useT } from '@/lib/i18n/I18nProvider';
import { IconClose, IconTarget } from '@/components/ui/icons';
import styles from './ContextChip.module.css';

interface Props { target: Target | null; onPick: () => void; onClear: () => void }

/** Context right in the input field (below the text): selected (with remove) or "automatic", in which case Lotse infers it from the message. */
export function ContextChip({ target, onPick, onClear }: Props) {
  const t = useT().context;
  if (target) {
    return (
      <span className={`${styles.chip} ${styles.set}`}>
          <button type="button" onClick={onPick} title={t.chip.change}>
            <IconTarget size={14} /><span className={styles.k}>{t.label}</span><b>{target.name ?? t.newLanding}</b>
          </button>
          <button type="button" className={styles.x} onClick={onClear} aria-label={t.chip.remove} title={t.chip.remove}><IconClose size={13} /></button>
      </span>
    );
  }
  return (
    <button type="button" className={styles.chip} onClick={onPick}
      title={t.chip.autoTitle}>
      <IconTarget size={14} /><span className={styles.k}>{t.label}</span><b>{t.chip.auto}</b><span className={styles.pick}>{t.chip.pick}</span>
    </button>
  );
}
