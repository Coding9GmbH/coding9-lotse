'use client';

import { Button } from '@/components/ui/Button';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { LogItem } from '@/lib/chat-state';
import styles from './CodeCards.module.css';

type Feedback = Extract<LogItem, { kind: 'pr_feedback' }>;
/** What the card can do: only for the sandbox attached to this chat (attachedTaskId); missing = Sandbox Coding off */
export interface PrFeedbackActions { attachedTaskId: string | null; busy: boolean; handOff: (f: Feedback) => void; finish: (taskId: string) => void }

/** Feedback on the sandbox's pull request (reviews, comments, failed checks), found by the server's watcher. Third-party text, shown as
 *  plain text; "An KI übergeben" starts a turn in which the server wraps it as data. Merged/closed: "Aufgabe abschließen". */
export function PrFeedbackCard({ item, actions }: { item: Feedback; actions?: PrFeedbackActions }) {
  const t = useI18n().t.sandbox.code.feedback;
  const attached = !!actions && actions.attachedTaskId === item.taskId;
  const heading = item.state ? t[item.state](item.number) : t.heading(item.number);
  return (
    <section className={`${styles.fb} ${item.state ? styles.fbEnded : ''}`} aria-label={heading}>
      <h3>{heading}</h3>
      {item.items.length > 0 && (
        <ul className={styles.fbList}>
          {item.items.map(i => (
            <li key={i.id}>
              <p className={styles.fbHead}>
                <b>{t.kind[i.kind]}</b>
                {i.kind === 'review' && i.state ? ` · ${t.review[i.state] ?? i.state}` : ''}
                {i.kind === 'check' && i.name ? ` · ${i.name}` : ''}
                {i.author ? ` · ${t.by(i.author)}` : ''}
                {i.path ? <> · <code>{i.path}{i.line ? `:${i.line}` : ''}</code></> : null}
                {i.url ? <> · <a href={i.url} target="_blank" rel="noopener noreferrer">{t.open}</a></> : null}
              </p>
              <p className={styles.fbBody}>{i.body || t.empty}</p>
            </li>
          ))}
        </ul>
      )}
      {item.more ? <p className={styles.pubNote}>{t.more(item.more)}</p> : null}
      {item.items.length > 0 && <p className={styles.pubNote}>{t.note}</p>}
      {item.state && attached && <p className={styles.pubNote}>{t.endedNote}</p>}
      {!attached && actions && <p className={styles.pubNote}>{t.detached}</p>}
      {attached && (
        <div className={styles.offerBtns}>
          {item.items.length > 0 && (item.handedOver
            ? <p className={styles.offerRepo} role="status"><b>{t.handedOver}</b></p>
            : <Button size="sm" variant="primary" disabled={actions.busy} onClick={() => actions.handOff(item)}>{t.handOff}</Button>)}
          {item.state && <Button size="sm" variant="danger" disabled={actions.busy} onClick={() => actions.finish(item.taskId)}>{t.finish}</Button>}
        </div>
      )}
    </section>
  );
}
