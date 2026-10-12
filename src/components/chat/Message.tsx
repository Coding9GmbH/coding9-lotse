import { useMemo } from 'react';
import type { Attachment, FileAttachment } from '@/lib/attachments';
import { markdown } from '@/lib/markdown';
import styles from './Message.module.css';

export function UserMessage({ text, attachments, files = [] }: { text: string; attachments: Attachment[]; files?: FileAttachment[] }) {
  return (
    <div className={`${styles.msg} ${styles.user}`}>
      {text}
      {attachments.length > 0 && (
        <div className={styles.thumbs}>
          {/* eslint-disable-next-line @next/next/no-img-element -- lokale, vorgemerkte Bilder */}
          {attachments.map(a => <img key={a.mediaId + a.url} src={a.url} alt={a.name} />)}
        </div>
      )}
      {files.length > 0 && (
        <div className={styles.files}>
          {files.map(f => <span key={f.fileId} title={f.name}>📄 {f.name}</span>)}
        </div>
      )}
    </div>
  );
}

/** Antwort der KI: Markdown-lite. markdown() maskiert jeden Text, bevor es die wenigen erlaubten Tags erzeugt. */
export function AiMessage({ text }: { text: string }) {
  const html = useMemo(() => markdown(text), [text]);
  return <div className={`${styles.msg} ${styles.ai}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ErrorMessage({ text }: { text: string }) {
  return <div className={`${styles.msg} ${styles.ai}`} role="alert">⚠️ {text}</div>;
}

/** Markdown-Block ohne Blase (für Rückfragen). */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => markdown(text), [text]);
  return <div className={[styles.md, className].filter(Boolean).join(' ')} dangerouslySetInnerHTML={{ __html: html }} />;
}
