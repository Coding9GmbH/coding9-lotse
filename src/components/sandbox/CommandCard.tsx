'use client';

import type { LogItem } from '@/lib/chat-state';
import { INTL_LOCALE } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/I18nProvider';
import styles from './CodeCards.module.css';

type Command = Extract<LogItem, { kind: 'command' }>;

/** An allow-listed command in the task container: "Theme kompiliert ✓ 12 s" or the end of the error output. */
export function CommandCard({ c }: { c: Command }) {
  const { locale, t: all } = useI18n();
  const t = all.sandbox.code.command;
  const label = (all.sandbox.commands as Record<string, string>)[c.command] ?? c.command;
  const sec = c.ms !== undefined ? (c.ms / 1000).toLocaleString(INTL_LOCALE[locale], { maximumFractionDigits: c.ms < 10_000 ? 1 : 0 }) : '';
  const args = c.args ? Object.values(c.args).join(' ') : '';
  const text = c.status === 'running' ? t.running(label) : c.status === 'ok' ? t.ok(label, sec) : t.failed(label, c.exitCode !== undefined ? String(c.exitCode) : '');
  return (
    <div className={`${styles.cmd} ${c.status === 'ok' ? styles.cmdOk : c.status === 'failed' ? styles.cmdBad : ''}`} role="status">
      <div className={styles.cmdHead}>
        <b className={c.status === 'running' ? styles.run : undefined}>{text}</b>
        {args && <code>{args}</code>}
      </div>
      {c.tail && c.status !== 'running' && (
        <details open={c.status === 'failed'}>
          <summary>{t.output}</summary>
          <pre>{c.tail}</pre>
        </details>
      )}
    </div>
  );
}

/** Status of the task's container before a turn (waking → ready, or failed). */
export function SandboxStatusLine({ state, message }: { state: 'waking' | 'ready' | 'failed'; message?: string }) {
  const t = useI18n().t.sandbox.code.sandbox;
  return <p className={`${styles.sbx} ${styles[`sbx_${state}`]}`} role="status"><i aria-hidden="true" />{t[state]}{state === 'failed' && message ? `: ${message}` : ''}</p>;
}

/** The AI's proposal for a pull request: title and description only, nothing is published from here. */
export function PublishProposalCard({ title, body }: { title: string; body: string }) {
  const t = useI18n().t.sandbox.code.publish;
  return (
    <section className={styles.pub} aria-label={t.heading}>
      <h3>{t.heading}</h3>
      <p><b>{title}</b></p>
      {body && <p className={styles.pubBody}>{body}</p>}
      <p className={styles.pubNote}>{t.note}</p>
    </section>
  );
}
