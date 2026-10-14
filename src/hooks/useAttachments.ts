'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { Attachment, FileAttachment } from '@/lib/attachments';
import { useT } from '@/lib/i18n/I18nProvider';

export interface PendingAttachment extends Partial<Attachment> { key: string; name: string; local: string; uploading: boolean; file?: FileAttachment }

/** Attachments: show images locally right away and queue them (POST /api/upload; into the shop only after approval), store files (CSV, Excel, PDF …) locally (POST /api/files). */
export function useAttachments(onError: (message: string) => void) {
  const [atts, setAtts] = useState<PendingAttachment[]>([]);
  const seq = useRef(0);
  const urls = useRef(new Set<string>());
  const uploadFailed = useT().lib.chat.uploadFailed;

  useEffect(() => () => { for (const u of urls.current) URL.revokeObjectURL(u); }, []);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    for (const f of files) {
      const key = `a${++seq.current}`;
      if (!f.type.startsWith('image/')) {
        setAtts(a => [...a, { key, name: f.name || 'datei', local: '', uploading: true }]);
        try {
          const r = await api.uploadFile(f);
          setAtts(a => a.map(x => (x.key === key ? { ...x, uploading: false, file: { fileId: r.fileId, name: r.name, mime: r.mime, size: r.size } } : x)));
        } catch (e) {
          setAtts(a => a.filter(x => x.key !== key));
          onError(uploadFailed(errorText(e)));
        }
        continue;
      }
      const local = URL.createObjectURL(f);
      urls.current.add(local);
      setAtts(a => [...a, { key, name: f.name || 'bild', local, uploading: true }]);
      try {
        const r = await api.upload(f);
        setAtts(a => a.map(x => (x.key === key ? { ...x, mediaId: r.mediaId, url: r.url, uploading: false } : x)));
      } catch (e) {
        setAtts(a => a.filter(x => x.key !== key));
        onError(uploadFailed(errorText(e)));
      }
    }
  }, [onError, uploadFailed]);

  const remove = useCallback((key: string) => setAtts(a => a.filter(x => x.key !== key)), []);
  const clear = useCallback(() => setAtts([]), []);
  const ready = (a: PendingAttachment): a is PendingAttachment & Attachment => !a.uploading && !!a.mediaId && !!a.url;

  return { atts, addFiles, remove, clear, uploading: atts.some(a => a.uploading), done: atts.filter(ready).map(a => ({ mediaId: a.mediaId, url: a.url, name: a.name })), files: atts.flatMap(a => (a.file ? [a.file] : [])) };
}
