'use client';

import type { LogItem } from '@/lib/chat-state';
import { INTL_LOCALE } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import styles from './CodeCards.module.css';

type Command = Extract<LogItem, { kind: 'command' }>;
type Offer = Extract<LogItem, { kind: 'sandbox_offer' }>;

/** Well-known Shopware commands get a readable name on the card (the command line is shown below anyway). */
const KNOWN: [RegExp, string][] = [[/\btheme:compile\b/, 'theme-compile'], [/\bcache:clear\b/, 'cache-clear'], [/\bplugin:refresh\b/, 'plugin-refresh'], [/\btheme:refresh\b/, 'theme-refresh'], [/\blint:twig\b/, 'lint-twig'], [/\bphp -l\b/, 'php-lint']];

/** A shell command in the task container (sandbox_bash): "Theme kompilieren ✓ 12 s" or the end of the error output. */
export function CommandCard({ c }: { c: Command }) {
  const { locale, t: all } = useI18n();
  const t = all.sandbox.code.command;
  const named = (all.sandbox.commands as Record<string, string>)[c.command] ?? KNOWN.find(([re]) => re.test(c.command))?.[1];
  const label = named ? (all.sandbox.commands as Record<string, string>)[named] ?? named : t.shell;
  const sec = c.ms !== undefined ? (c.ms / 1000).toLocaleString(INTL_LOCALE[locale], { maximumFractionDigits: c.ms < 10_000 ? 1 : 0 }) : '';
  const args = c.args ? Object.values(c.args).join(' ') : '';
  const text = c.status === 'running' ? t.running(label) : c.status === 'ok' ? t.ok(label, sec) : t.failed(label, c.exitCode !== undefined ? String(c.exitCode) : '');
  return (
    <div className={`${styles.cmd} ${c.status === 'ok' ? styles.cmdOk : c.status === 'failed' ? styles.cmdBad : ''}`} role="status">
      <div className={styles.cmdHead}>
        <b className={c.status === 'running' ? styles.run : undefined}>{text}</b>
        {args ? <code>{args}</code> : c.command !== named && <code>$ {c.command}</code>}
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

/** The AI's proposal for a pull request: title and description only, nothing is published from here. With a sandbox attached,
 *  "Prüfen und veröffentlichen" opens the "Pull Request" tab with it (only the click there publishes). */
export function PublishProposalCard({ title, body, onReview }: { title: string; body: string; onReview?: () => void }) {
  const t = useI18n().t.sandbox.code.publish;
  return (
    <section className={styles.pub} aria-label={t.heading}>
      <h3>{t.heading}</h3>
      <p><b>{title}</b></p>
      {body && <p className={styles.pubBody}>{body}</p>}
      {onReview ? <div className={styles.pubBtns}><Button size="sm" variant="primary" onClick={onReview}>{t.review}</Button></div> : <p className={styles.pubNote}>{t.note}</p>}
      {onReview && <p className={styles.pubNote}>{t.reviewNote}</p>}
    </section>
  );
}

/** start_sandbox / chat: what a card needs to attach a sandbox to this chat. */
export interface SandboxOfferActions {
  /** a sandbox is attached already (the card is only a record then) */ attached: boolean;
  /** direct = create with the card's repository and branch; otherwise the dialog opens prefilled */
  start: (offer: { repo: string; baseBranch: string }, direct: boolean) => void;
  busy?: boolean;
}

/** The AI proposes a sandbox (start_sandbox): nothing starts until the user clicks. */
export function SandboxOfferCard({ offer, actions }: { offer: Offer; actions?: SandboxOfferActions }) {
  const t = useI18n().t.sandbox.code.offer;
  const where = offer.repo ? `${offer.repo}${offer.baseBranch ? ` @ ${offer.baseBranch}` : ''}` : t.noRepo;
  return (
    <section className={styles.offer} aria-label={t.heading}>
      <h3>{t.heading}</h3>
      <p>{offer.reason}</p>
      <p className={styles.offerRepo}><code>{where}</code></p>
      {!actions ? <p className={styles.pubNote}>{t.off}</p> : actions.attached ? <p className={styles.pubNote}>{t.attached}</p> : (
        <div className={styles.offerBtns}>
          <Button size="sm" variant="primary" disabled={actions.busy} onClick={() => actions.start(offer, !!offer.repo && !!offer.baseBranch)}>{t.start}</Button>
          <Button size="sm" disabled={actions.busy} onClick={() => actions.start(offer, false)}>{t.adjust}</Button>
        </div>
      )}
    </section>
  );
}

/** Line in the history: from here on the chat works in the sandbox. */
export function SandboxAttachedLine({ repo, baseBranch }: { repo: string; baseBranch: string }) {
  const t = useI18n().t.sandbox.code.offer;
  return <p className={`${styles.sbx} ${styles.sbx_ready}`} role="status"><i aria-hidden="true" />{t.attachedLine(repo, baseBranch)}</p>;
}
