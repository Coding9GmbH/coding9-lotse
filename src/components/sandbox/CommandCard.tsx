'use client';

import type { LogItem } from '@/lib/chat-state';
import { INTL_LOCALE } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import { IconCheck } from '@/components/ui/icons';
import { Markdown } from '@/components/chat/Message';
import styles from './CodeCards.module.css';

type Command = Extract<LogItem, { kind: 'command' }>;
type Offer = Extract<LogItem, { kind: 'sandbox_offer' }>;
type InternetAsk = Extract<LogItem, { kind: 'internet' }>;

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

/** Status of the task's container (waking → ready, a failed setup, finished): a static check once finished. */
export function SandboxStatusLine({ state, message }: { state: 'waking' | 'ready' | 'failed' | 'finished'; message?: string }) {
  const t = useI18n().t.sandbox.code.sandbox;
  return (
    <p className={`${styles.sbx} ${styles[`sbx_${state}`]}`} role="status">
      {state === 'finished' ? <IconCheck size={13} className={styles.sbxCheck} /> : <i aria-hidden="true" />}{t[state]}{state === 'failed' && message ? `: ${message}` : ''}
    </p>
  );
}

/** The AI's proposal for a pull request: title and description (Markdown, rendered like the chat), nothing is published from here.
 *  With a sandbox attached, "Prüfen und veröffentlichen" opens the "Pull Request" tab with it (only the click there publishes).
 *  `publishedAs`: a pull request was created or updated after this proposal; `update`: a PR exists and this proposal is newer. */
export function PublishProposalCard({ title, body, onReview, publishedAs, update }: {
  title: string; body: string; onReview?: () => void; publishedAs?: { number: number; url: string } | null; update?: boolean;
}) {
  const t = useI18n().t.sandbox.code.publish;
  return (
    <section className={styles.pub} aria-label={t.heading}>
      <h3>{t.heading}</h3>
      <p><b>{title}</b></p>
      {body && <Markdown text={body} className={styles.pubBody} />}
      {publishedAs
        ? <p className={styles.pubDone}><IconCheck size={14} /><a href={publishedAs.url} target="_blank" rel="noopener noreferrer">{t.publishedAs(publishedAs.number)}</a></p>
        : onReview
          ? <><div className={styles.pubBtns}><Button size="sm" variant="primary" onClick={onReview}>{update ? t.reviewUpdate : t.review}</Button></div><p className={styles.pubNote}>{t.reviewNote}</p></>
          : <p className={styles.pubNote}>{t.note}</p>}
    </section>
  );
}

/** start_sandbox / chat: what a card needs to attach a sandbox to this chat. */
export interface SandboxOfferActions {
  /** a sandbox is attached already (the card is only a record then) */ attached: boolean;
  /** direct = create with the card's repository and branch (title from the reason); otherwise the dialog opens prefilled */
  start: (offer: { repo: string; baseBranch: string; reason: string; pluginName?: string }, direct: boolean) => void;
  busy?: boolean;
  /** why a sandbox cannot start right now (Docker unreachable), shown as the button's tooltip */ blocked?: string | null;
}

/** Default title (and branch slug) of a sandbox started from the AI's card: its reason, shortened to about 60 characters at a word. */
export function offerTitle(reason: string): string {
  const r = reason.replace(/\s+/g, ' ').trim();
  if (r.length <= 60) return r.replace(/[.:;,]$/, '');
  const cut = r.slice(0, 60), sp = cut.lastIndexOf(' ');
  return `${(sp > 30 ? cut.slice(0, sp) : cut).replace(/[.:;,]$/, '')} …`;
}

/** The AI proposes a sandbox (start_sandbox): nothing starts until the user clicks. Once a sandbox is attached, the card folds into
 *  one line (the "Sandbox angehängt" line below says the rest). */
export function SandboxOfferCard({ offer, actions }: { offer: Offer; actions?: SandboxOfferActions }) {
  const t = useI18n().t.sandbox.code.offer;
  const where = offer.repo ? `${offer.repo}${offer.baseBranch ? ` @ ${offer.baseBranch}` : ''}` : t.noRepo;
  if (actions?.attached) return <p className={styles.sbx} role="note"><IconCheck size={13} className={styles.sbxCheck} />{t.accepted}: {offer.reason}</p>;
  return (
    <section className={styles.offer} aria-label={t.heading}>
      <h3>{t.heading}</h3>
      <p>{offer.reason}</p>
      <p className={styles.offerRepo}><code>{where}</code></p>
      {offer.pluginName && <p className={styles.offerRepo}>{t.newPlugin} <code>{offer.pluginName}</code></p>}
      <p className={styles.pubNote}>{t.note}</p>
      {!actions ? <p className={styles.pubNote}>{t.off}</p> : (
        <div className={styles.offerBtns}>
          <Button variant="primary" disabled={actions.busy || !!actions.blocked} title={actions.blocked ?? undefined} onClick={() => actions.start(offer, !!offer.repo && !!offer.baseBranch)}>{t.start}</Button>
          <Button disabled={actions.busy} onClick={() => actions.start(offer, false)}>{t.adjust}</Button>
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

/** request_internet: the AI asks for internet in the task container. Only the click on "Für diese Sandbox erlauben" attaches it.
 *  A risk decision: coral like the feedback card. `on`: the sandbox's current internet state (an allowed request may be blocked again since). */
export function InternetRequestCard({ item, onDecide, on }: { item: InternetAsk; onDecide: (allow: boolean) => void; on?: boolean | null }) {
  const t = useI18n().t.sandbox.code.internet;
  const allowed = item.decision === true && !item.error && !item.restart;
  return (
    <section className={`${styles.offer} ${styles.risk}`} aria-label={t.heading}>
      <h3>{t.heading}</h3>
      <p>{t.reason(item.reason)}</p>
      <p className={styles.pubNote}>{t.note}</p>
      {item.interactive ? (
        <div className={styles.offerBtns}>
          <Button size="sm" variant="primary" onClick={() => onDecide(true)}>{t.allow}</Button>
          <Button size="sm" onClick={() => onDecide(false)}>{t.deny}</Button>
        </div>
      ) : <p className={styles.offerRepo} role="status"><b>{item.error ? t.failed : item.restart ? t.restart : allowed ? (on === false ? t.revokedSince : t.allowed) : item.decision === false ? t.denied : t.open}</b>{item.error ? ` ${item.error}` : null}</p>}
    </section>
  );
}
