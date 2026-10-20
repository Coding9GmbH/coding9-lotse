'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { announceAnswer } from '@/lib/a11y';
import type { LogItem, Step } from '@/lib/chat-state';
import type { AppConfig } from '@/lib/protocol';
import { useLocale } from '@/lib/i18n/I18nProvider';
import { ChangeSetCard } from './ChangeSetCard';
import { ImageCard, PublishedCard, StyleguideCard } from './Cards';
import { AiMessage, ErrorMessage, UserMessage } from './Message';
import { QuestionCard } from './QuestionCard';
import { Steps } from './Steps';
import { CommandCard, InternetRequestCard, PublishProposalCard, SandboxAttachedLine, ZipProposalCard, SandboxOfferCard, SandboxStatusLine, type SandboxOfferActions } from '@/components/sandbox/CommandCard';
import { FileChangeCard } from '@/components/sandbox/FileChangeCard';
import { PrCard } from '@/components/sandbox/PrCard';
import { PrFeedbackCard, type PrFeedbackActions } from '@/components/sandbox/PrFeedbackCard';
import type { PrProposal } from '@/components/sandbox/PublishCard';
import styles from './ChatLog.module.css';

interface Props {
  items: LogItem[];
  cfg: AppConfig | null;
  onAnswer: (approvalId: string, answer: string) => void;
  onDecide: (approvalId: string, allow: boolean, selected?: string[]) => void;
  onUndo: (csId: string) => void;
  onOpenStyleguide: () => void;
  /** true while a turn is running. The announcement only comes once it is finished. */
  busy?: boolean;
  className?: string;
  children?: React.ReactNode;
  /** start_sandbox cards: start (directly or via the dialog); missing = Sandbox Coding off */
  sandbox?: SandboxOfferActions;
  /** publish_proposal cards: open the "Pull Request" tab with this proposal (publishes nothing); missing = no sandbox attached */
  onReviewPublish?: (p: PrProposal) => void;
  /** propose_zip cards: open the "Freigabe" tab, where the ZIP is checked and downloaded (downloads nothing); missing = no sandbox attached */
  onOpenZip?: () => void;
  /** pr_feedback cards: hand over to the AI, finish the task (merged/closed); missing = Sandbox Coding off */
  prFeedback?: PrFeedbackActions;
  /** internet state of the attached sandbox (an allowed request card says when it was blocked again); undefined = unknown */
  sandboxInternet?: boolean | null;
}

/** Tools whose result is its own card (file, command, proposal, request, question): no extra work-step line for them unless they failed. */
const CARD_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'write_file', 'edit_file', 'delete_file', 'sandbox_bash', 'start_sandbox', 'propose_publish', 'propose_zip', 'request_internet', 'ask_user']);
const stepsShown = (steps: Step[]) => steps.filter(s => s.state === 'bad' || !CARD_TOOLS.has(s.name));

/** Per pull request proposal: the PR card that followed it (published), or whether a PR already existed before (then "aktualisieren"). */
function proposalStates(items: LogItem[]) {
  const out = new Map<string, { publishedAs: { number: number; url: string } | null; update: boolean }>();
  let lastPr: { number: number; url: string } | null = null;
  const pending: string[] = [];
  for (const i of items) {
    if (i.kind === 'publish') { out.set(i.key, { publishedAs: null, update: !!lastPr }); pending.push(i.key); }
    else if (i.kind === 'pr') {
      lastPr = { number: i.number, url: i.url };
      for (const k of pending.splice(0)) out.set(k, { publishedAs: lastPr, update: false });
    }
  }
  return out;
}

function AnswerStatus({ busy, hasAnswer }: { busy: boolean; hasAnswer: boolean }) {
  const locale = useLocale();
  const [snap, setSnap] = useState({ busy: false, text: null as string | null });
  if (busy !== snap.busy) {
    const text = snap.busy && !busy && hasAnswer ? announceAnswer(true, locale) : null;
    setSnap({ busy, text });
  }
  return snap.text ? <p className="visually-hidden" role="status">{snap.text}</p> : null;
}

const NEAR_END = 140;
/** These entries always scroll the log to the end (own message, decision needed). */
const FORCE_FOLLOW = new Set<LogItem['kind']>(['user', 'question', 'changeset', 'publish', 'zip', 'pr', 'sandbox_offer', 'internet', 'pr_feedback']);

/** Chat log. Stays "stuck" to the end as long as the user has not scrolled up. */
export function ChatLog({ items, cfg, onAnswer, onDecide, onUndo, onOpenStyleguide, busy = false, className, children, sandbox, onReviewPublish, onOpenZip, prFeedback, sandboxInternet }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const last = items.at(-1);
    const isNew = !!last && last.key !== lastKey.current;
    lastKey.current = last?.key ?? null;
    if (stick.current || (isNew && FORCE_FOLLOW.has(last.kind))) { el.scrollTop = el.scrollHeight; stick.current = true; }
  }, [items]);

  const last = items.at(-1);
  const hasAnswer = last?.kind === 'ai' && !!last.text;
  const proposals = useMemo(() => proposalStates(items), [items]);

  return (
    <div ref={ref} className={[styles.log, className].filter(Boolean).join(' ')} role="log" aria-live="polite" aria-relevant="additions"
      onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END; }}>
      <AnswerStatus busy={busy} hasAnswer={hasAnswer} />
      {children}
      {items.map(item => {
        switch (item.kind) {
          case 'user': return <UserMessage key={item.key} text={item.text} attachments={item.attachments} files={item.files} />;
          case 'ai': return item.text ? <AiMessage key={item.key} text={item.text} /> : null;
          case 'error': return <ErrorMessage key={item.key} text={item.text} />;
          case 'steps': { const shown = stepsShown(item.steps); return shown.length ? <Steps key={item.key} steps={shown} /> : null; }
          case 'image': return <ImageCard key={item.key} url={item.url} alt={item.alt} fileName={item.fileName} />;
          case 'question':
            return <QuestionCard key={item.key} question={item.question} options={item.options} answer={item.answer} interactive={item.interactive}
              onAnswer={a => onAnswer(item.approvalId, a)} />;
          case 'changeset':
            return <ChangeSetCard key={item.key} cs={item.cs} interactive={item.interactive} decision={item.decision} sent={item.sent}
              result={item.result} progress={item.progress} undo={item.undo} onDecide={(allow, sel) => onDecide(item.approvalId, allow, sel)} onUndo={() => onUndo(item.cs.id)} />;
          case 'published': return <PublishedCard key={item.key} info={item.info} target={item.target} cfg={cfg} />;
          case 'styleguide': return <StyleguideCard key={item.key} sg={item.sg} onOpen={onOpenStyleguide} />;
          case 'file': return <FileChangeCard key={item.key} path={item.path} kind={item.change} added={item.added} removed={item.removed} />;
          case 'command': return <CommandCard key={item.key} c={item} />;
          case 'sandbox': return <SandboxStatusLine key={item.key} state={item.state} message={item.message} paused={item.paused} max={item.max} />;
          case 'publish': return <PublishProposalCard key={item.key} title={item.title} body={item.body} {...proposals.get(item.key)}
            onReview={onReviewPublish ? () => onReviewPublish({ key: item.key, title: item.title, body: item.body }) : undefined} />;
          case 'zip': return <ZipProposalCard key={item.key} note={item.note} onOpen={onOpenZip} />;
          case 'pr': return <PrCard key={item.key} taskId={item.taskId} pr={item} done={{ action: item.action, files: item.files }} />;
          case 'pr_feedback': return <PrFeedbackCard key={item.key} item={item} actions={prFeedback} />;
          case 'sandbox_offer': return <SandboxOfferCard key={item.key} offer={item} actions={sandbox} />;
          case 'sandbox_attached': return <SandboxAttachedLine key={item.key} repo={item.repo} baseBranch={item.baseBranch} />;
          case 'internet': return <InternetRequestCard key={item.key} item={item} on={sandboxInternet} onDecide={allow => onDecide(item.approvalId, allow)} />;
        }
      })}
    </div>
  );
}
