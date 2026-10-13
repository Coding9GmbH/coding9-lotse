// Anhänge werden als Marker an die Nachricht gehängt, damit die KI sie kennt:
// Bilder (in Shopware hochgeladen) mit mediaId + URL, Dateien (lokal, z. B. CSV/PDF) mit fileId.

import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

export interface Attachment { mediaId: string; url: string; name: string }
export interface FileAttachment { fileId: string; name: string; mime: string; size: number }

const MARKER = /\[Anhang: mediaId=(\S+?), url=(\S+?), name=([^\]\n]*)\]/g;
const FILE_MARKER = /\[Datei: fileId=(\S+?), typ=(\S+?), bytes=(\d+), name=([^\]\n]*)\]/g;

// Namen bleiben lesbar (Umlaute, Leerzeichen); nur „]“, „%“ und Zeilenumbrüche würden den Marker zerreißen → Prozent-kodiert
const encName = (s: string) => s.replace(/[%\]\n\r]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const decName = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } }; // ältere Chats: Name unkodiert

export function attachmentMessage(text: string, atts: Attachment[], files: FileAttachment[] = [], locale: Locale = DEFAULT_LOCALE): string {
  if (!atts.length && !files.length) return text;
  const t = messages(locale).lib.attachments;
  const fallback = files.length ? t.filesFallback : t.imagesFallback;
  return (text || fallback) + '\n\n'
    + [...atts.map(a => `[Anhang: mediaId=${a.mediaId}, url=${a.url}, name=${encName(a.name)}]`),
      ...files.map(f => `[Datei: fileId=${f.fileId}, typ=${f.mime}, bytes=${f.size}, name=${encName(f.name)}]`)].join('\n');
}

/** Nachricht in sichtbaren Text + Anhänge zerlegen (nur vollständige Marker; eigener Text wie „[Anhang: alt]“ bleibt stehen). */
export function parseAttachments(message: string): { text: string; attachments: Attachment[]; files: FileAttachment[] } {
  const attachments = [...message.matchAll(MARKER)].map(m => ({ mediaId: m[1], url: m[2], name: decName(m[3]) }));
  const files = [...message.matchAll(FILE_MARKER)].map(m => ({ fileId: m[1], mime: m[2], size: Number(m[3]), name: decName(m[4]) }));
  return { text: message.replace(MARKER, '').replace(FILE_MARKER, '').trim(), attachments, files };
}
