import 'server-only';
// Shopify: upload staged images (staged:…) after approval. stagedUploadsCreate (POST, multipart as documented by Shopify)
// → send the file to the target → resourceUrl as originalSource for product media or files. Executor only (privileged client).
import { readStaged, stagedMeta } from '../../media';
import type { Json, ShopifyClient } from './client';
import { M, run } from './ops';

export interface ImageSource { originalSource: string; alt: string; ai?: boolean }

/** Upload an image from the local staging; returns the resourceUrl */
export async function uploadStagedImage(client: ShopifyClient, stagedId: string, f: typeof fetch = fetch): Promise<ImageSource> {
  const meta = stagedMeta(stagedId), file = readStaged(stagedId);
  if (!meta || !file) throw new Error(`Vorgemerktes Bild ${stagedId} nicht gefunden`);
  const filename = `${meta.ai ? 'ki-' : ''}${meta.name}.${meta.file.split('.').pop()}`;
  const r = await run<Json>(client, M.stagedUploads, { input: [{ resource: 'IMAGE', filename, mimeType: meta.mime, httpMethod: 'POST', fileSize: String(file.buf.length) }] });
  const t = r.stagedTargets?.[0]; if (!t?.url || !t.resourceUrl) throw new Error('Shopify lieferte kein Upload-Ziel');
  const form = new FormData();
  for (const p of t.parameters ?? []) form.append(p.name, p.value);
  form.append('file', new Blob([new Uint8Array(file.buf)], { type: meta.mime }), filename);
  const up = await f(t.url, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
  if (!up.ok) throw new Error(`Bild-Upload fehlgeschlagen (HTTP ${up.status})`);
  const alt = meta.alt ?? meta.name;
  return { originalSource: t.resourceUrl, alt: meta.ai ? `${alt} (KI-generiert)` : alt, ai: meta.ai };
}
