'use client';

import type { Target } from '@/lib/protocol';
import { IconClose, IconTarget } from '@/components/ui/icons';
import styles from './ContextChip.module.css';

interface Props { target: Target | null; onPick: () => void; onClear: () => void }

/** Kontext direkt im Eingabefeld (unter dem Text): gewählt (mit Entfernen) oder „automatisch“ – dann findet Lotse ihn aus der Nachricht. */
export function ContextChip({ target, onPick, onClear }: Props) {
  if (target) {
    return (
      <span className={`${styles.chip} ${styles.set}`}>
          <button type="button" onClick={onPick} title="Anderen Kontext wählen">
            <IconTarget size={14} /><span className={styles.k}>Kontext</span><b>{target.name ?? 'Neue Landingpage'}</b>
          </button>
          <button type="button" className={styles.x} onClick={onClear} aria-label="Kontext entfernen" title="Kontext entfernen"><IconClose size={13} /></button>
      </span>
    );
  }
  return (
    <button type="button" className={styles.chip} onClick={onPick}
      title="Ohne Auswahl findet Lotse Kategorie, Produkt oder Seite selbst aus deiner Nachricht.">
      <IconTarget size={14} /><span className={styles.k}>Kontext</span><b>automatisch</b><span className={styles.pick}>wählen</span>
    </button>
  );
}
