import 'server-only';
// Medien: Import per URL (serverseitiger Download), Datei-Upload, SVG-Erstellung, optionale KI-Bildgenerierung → Shopware-Medienbibliothek
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PLATFORM_KINDS } from '@/lib/platforms';
import { dataDir, kvGet, kvSet } from './db';
import { fetchWithRetry } from './retry';
import { getSettings, platformConfig } from './settings';
import type { Shopware } from './shopware';
import { singleton } from './state';
import type { Fetcher } from './styleguide';
import { errMsg } from './util';

export const MIME_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
const EXT_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));
const MAX = 20 * 1024 * 1024;
const slug = (s: unknown) => String(s || 'bild').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'bild';

export interface UploadResult { mediaId: string; url?: string; fileName: string; alt: string | null }
export async function uploadBuffer(sw: Shopware, buf: Buffer, mime: string, { name, alt, title, folder = 'cms_page' }: { name?: string; alt?: string | null; title?: string; folder?: string } = {}): Promise<UploadResult> {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`Bildtyp ${mime} wird nicht unterstützt (erlaubt: ${Object.keys(MIME_EXT).join(', ')})`);
  if (buf.length > MAX) throw new Error('Bild größer als 20 MB');
  const folderId = (await sw.search('media-default-folder', { filter: [{ type: 'equals', field: 'entity', value: folder }], associations: { folder: {} }, limit: 1 })).data?.[0]?.folder?.id ?? null;
  const id = await sw.uploadMediaBinary(buf, { ext, mime, fileName: `${slug(name)}-${Math.random().toString(36).slice(2, 7)}`, folderId });
  if (alt || title) await sw.update('media', id, { alt: alt ?? null, title: title ?? alt });
  const m = await sw.get('media', id);
  return { mediaId: id, url: m?.url, fileName: `${m?.fileName}.${m?.fileExtension}`, alt: alt ?? null };
}

// Laufzeit-Konfiguration (runtime.ts setzt sie nach jeder Einstellungsänderung)
const rt = () => singleton('media', () => ({ fetch: fetch as Fetcher, img: { key: '', model: '' }, origins: (async () => []) as () => Promise<string[]> }));
export const setFetcher = (f: Fetcher) => { rt().fetch = f; };
export const setImageConfig = (c: { key: string; model: string }) => { rt().img = c; };
/** Weitere vertrauenswürdige Shop-Adressen (z. B. Domains der Verkaufskanäle), zusätzlich zu den URLs aus den Einstellungen */
export const setTrustedOrigins = (f: () => Promise<string[]>) => { rt().origins = f; };

// ---- Schutz vor Zugriffen ins interne Netz (SSRF): Die KI darf Bilder nur vom eigenen Shop oder aus dem öffentlichen Internet laden ----
const originOf = (u: string) => { try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).origin; } catch { return null; } };
/** Adressen des verbundenen Shops (alle Plattform-URLs der Einstellungen + Laufzeit-Domains): dort ist auch eine interne/lokale Adresse erlaubt */
export async function trustedOrigins(): Promise<Set<string>> {
  const g = getSettings(), urls: string[] = [];
  for (const k of PLATFORM_KINDS) for (const [key, v] of Object.entries(platformConfig(k, g))) if (/url|domain/i.test(key) && v) urls.push(v);
  urls.push(...(await rt().origins().catch(() => [])));
  return new Set(urls.map(originOf).filter((o): o is string => !!o));
}
const privateV4 = (ip: string) => { const [a, b] = ip.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || a === 192 && b === 168; };
/** Loopback, private Netze, Link-local (Cloud-Metadaten), CGNAT, IPv6-Gegenstücke und IPv4-mapped */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v = ip.toLowerCase().replace(/^\[|\]$/g, ''), m4 = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/), mh = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m4) return privateV4(m4[1]);
  if (mh) { const hi = parseInt(mh[1], 16), lo = parseInt(mh[2], 16); return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); } // URL normalisiert ::ffff:10.0.0.1 zu ::ffff:a00:1
  return v === '::' || v === '::1' || /^f[cd][0-9a-f]{2}:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v);
}
/** Nur http(s) auf öffentliche Adressen; Hostnamen werden aufgelöst, damit „localhost“ oder ein interner DNS-Name nicht durchrutscht */
export async function assertPublicUrl(url: string): Promise<void> {
  let u: URL; try { u = new URL(url); } catch { throw new Error(`${url} ist keine gültige URL`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${url}: nur http(s)-Adressen`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(a => a.address);
  if (!addrs.length) throw new Error(`${url}: Host nicht auflösbar`);
  if (addrs.some(isPrivateIp)) throw new Error(`${url}: interne oder lokale Adressen sind nicht erlaubt (nur der eigene Shop oder öffentliche Bild-URLs)`);
}
const REDIRECT = new Set([301, 302, 303, 307, 308]);
export async function downloadImage(url: string) {
  const trusted = await trustedOrigins();
  let cur = url;
  for (let hop = 0; ; hop++) {
    const own = trusted.has(originOf(cur) ?? '');
    if (!own) await assertPublicUrl(cur);
    // fremde Hosts: kein Status/Fehlercode an die KI (sonst Erreichbarkeits-Orakel), Weiterleitungen werden einzeln geprüft (max. 3)
    const fail = (detail: string) => new Error(`Download von ${cur} fehlgeschlagen${own ? `: ${detail}` : ' (nicht erreichbar oder kein Bild)'}`);
    let r: Response;
    try { r = await rt().fetch(cur, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Lotse)', accept: 'image/*' }, signal: AbortSignal.timeout(25_000) }); }
    catch (e) { throw fail(errMsg(e)); }
    if (REDIRECT.has(r.status)) {
      const loc = r.headers.get('location'); await r.body?.cancel().catch(() => {});
      if (!loc || hop >= 3) throw fail('zu viele Weiterleitungen');
      cur = new URL(loc, cur).href; continue;
    }
    if (!r.ok) throw fail(`HTTP ${r.status}`);
    const mime = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) throw new Error(`${cur} ist kein Bild (Content-Type: ${mime || 'unbekannt'})`);
    return { buf: Buffer.from(await r.arrayBuffer()), mime };
  }
}
export async function importFromUrl(sw: Shopware, url: string, { alt, name, folder }: { alt?: string; name?: string; folder?: string } = {}) { // schreibend – nur im Executor nach Freigabe
  const { buf, mime } = await downloadImage(url);
  return uploadBuffer(sw, buf, mime, { name: name ?? (new URL(url).pathname.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/i, ''), alt, folder });
}

// ---- Staging: Bilder der KI liegen NUR lokal (data/staging), bis eine Veröffentlichung freigegeben wird ----
export const stageDir = () => path.join(dataDir(), 'staging');
const readMap = () => kvGet<Record<string, string>>('staging_map') ?? {};
/** ai: von der Bild-KI erzeugt – muss auf der Seite und in der Medienverwaltung als KI-generiert gekennzeichnet sein */
export interface StagedMeta { id: string; file: string; mime: string; name: string; alt: string | null; ai?: boolean }
export interface StagedResult { mediaId: string; url: string; fileName: string; alt: string | null; staged: true }
export function stageImage(buf: Buffer, mime: string, { name, alt, ai }: { name?: string; alt?: string | null; ai?: boolean } = {}): StagedResult {
  const ext = MIME_EXT[mime]; if (!ext) throw new Error(`Bildtyp ${mime} wird nicht unterstützt`);
  if (buf.length > MAX) throw new Error('Bild größer als 20 MB');
  const dir = stageDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36), file = `${id}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, file, mime, name: slug(name), alt: alt ?? null, ...(ai ? { ai: true } : {}) }));
  return { mediaId: `staged:${id}`, url: `/staged/${file}`, fileName: file, alt: alt ?? null, staged: true };
}
export async function stageFromUrl(url: string, { alt, name }: { alt?: string; name?: string } = {}) { const { buf, mime } = await downloadImage(url); return stageImage(buf, mime, { name: name ?? alt, alt }); }
const STAGE_ID = /^[a-z0-9]+$/;
export const stagedMeta = (id: string): StagedMeta | null => { if (!STAGE_ID.test(id)) return null; try { return JSON.parse(fs.readFileSync(path.join(stageDir(), `${id}.json`), 'utf8')); } catch { return null; } };
/** IDs aller vorgemerkten KI-Bilder, die in einem Text/JSON vorkommen („/staged/<id>.png“ oder „staged:<id>“). */
export function aiImageIds(text: string): string[] {
  const ids = new Set([...text.matchAll(/(?:\/staged\/|staged:)([a-z0-9]+)/g)].map(m => m[1]));
  return [...ids].filter(id => stagedMeta(id)?.ai);
}

// KI-Bilder aus der Medienverwaltung des Shops: erkannt am Titel/Alt-Text/Dateinamen, gemerkt über den URL-Pfad
const AI_MEDIA = /\bKI[- ]?generiert|\bAI[- ]?generated|\bki-bild/i;
const aiMediaPaths = () => singleton('aiMediaPaths', () => new Set<string>());
// Vergleich ab „/media/“, damit dieselbe Datei über Shop-Domain, Proxy (/shop/…) oder Thumbnail-Pfad erkannt wird
const pathOf = (url: string) => { let p = url; try { p = new URL(url, 'http://x').pathname; } catch { /* relativ */ } const i = p.indexOf('/media/'); return i >= 0 ? p.slice(i) : p; };
/** Merkt sich ein Shop-Medium als KI-Bild, wenn es so gekennzeichnet ist; liefert true für KI-Bilder. */
export function noteMedia(m: { url?: string | null; title?: string | null; alt?: string | null; fileName?: string | null } | null | undefined): boolean {
  if (!m?.url || !AI_MEDIA.test(`${m.title ?? ''} ${m.alt ?? ''} ${m.fileName ?? ''}`)) return false;
  aiMediaPaths().add(pathOf(m.url));
  return true;
}
/** Ist diese Bild-URL KI-generiert (vorgemerktes KI-Bild oder als KI gekennzeichnetes Shop-Medium)? */
export const isAiImageUrl = (url: string) => aiImageIds(url).length > 0 || aiMediaPaths().has(pathOf(url));
/** Alle KI-Bilder in einem Text/JSON (vorgemerkte und bekannte Shop-Medien). */
export function aiImagesIn(text: string): string[] {
  return [...aiImageIds(text), ...[...aiMediaPaths()].filter(p => text.includes(p))];
}
export const AI_CREDIT = 'Bild: KI-generiert';
/** Vorgemerktes Bild lesen (z. B. zum Ansehen durch die KI). */
export function readStaged(id: string): { buf: Buffer; mime: string; name: string } | null {
  const m = stagedMeta(id); if (!m) return null;
  return { buf: fs.readFileSync(path.join(stageDir(), m.file)), mime: m.mime, name: m.name };
}
export async function uploadStaged(sw: Shopware, id: string, { folder }: { folder?: string } = {}): Promise<string> { // schreibend – nur im Executor nach Freigabe
  const map = readMap(); if (map[id] && await sw.get('media', map[id]).catch(() => null)) return map[id]; // schon hochgeladen und noch vorhanden: nicht doppelt
  const meta = stagedMeta(id); if (!meta) throw new Error(`Vorgemerktes Bild ${id} nicht gefunden`);
  const up = await uploadBuffer(sw, fs.readFileSync(path.join(stageDir(), meta.file)), meta.mime,
    meta.ai ? { name: `ki-${meta.name}`, alt: meta.alt, title: `KI-generiert: ${meta.alt ?? meta.name}`, folder } : { name: meta.name, alt: meta.alt, folder });
  kvSet('staging_map', { ...readMap(), [id]: up.mediaId }); return up.mediaId;
}

/** Auslieferung vorgemerkter Bilder: nur Bilddateien direkt im Staging-Ordner (kein Pfad-Ausbruch). */
export function stagedFile(segments: string[]): { path: string; mime: string } | null {
  if (segments.length !== 1) return null;
  const name = segments[0];
  const m = /^[a-z0-9]+\.([a-z0-9]+)$/i.exec(name);
  const mime = m ? EXT_MIME[m[1].toLowerCase()] : undefined;
  if (!mime) return null;
  const dir = path.resolve(stageDir()), p = path.resolve(dir, name);
  if (path.dirname(p) !== dir || !p.startsWith(dir + path.sep)) return null;
  return { path: p, mime };
}

// ---- SVG der KI prüfen: kein Script, keine Event-Handler, keine Animationen/Styles, keine externen Referenzen ----
// Nicht „entschärfen“ (Strippen ist per Entity-Kodierung, Tag-Splitting oder ungequoteten Attributen umgehbar), sondern ABLEHNEN:
// Die Datei landet nach Freigabe unverändert in der Medienverwaltung und wird vom Shop ohne CSP ausgeliefert.
const SVG_ELEMENTS = new Set(['svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath', 'title', 'desc', 'metadata',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker', 'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite',
  'feFlood', 'feMerge', 'feMergeNode', 'feMorphology', 'feDropShadow', 'feTurbulence', 'feDisplacementMap', 'feFuncR', 'feFuncG', 'feFuncB', 'feFuncA', 'feSpecularLighting', 'feDiffuseLighting', 'feDistantLight', 'fePointLight', 'feSpotLight']);
const SVG_ATTRS = new Set(['id', 'class', 'style', 'xmlns', 'xmlns:xlink', 'version', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'dx', 'dy', 'rotate',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'stroke-miterlimit', 'opacity', 'color', 'transform', 'transform-origin',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'letter-spacing', 'word-spacing', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'text-decoration', 'textLength', 'lengthAdjust', 'startOffset', 'method', 'spacing',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'patternUnits', 'patternContentUnits', 'patternTransform', 'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits',
  'filter', 'filterUnits', 'primitiveUnits', 'in', 'in2', 'result', 'stdDeviation', 'mode', 'type', 'values', 'flood-color', 'flood-opacity', 'operator', 'k1', 'k2', 'k3', 'k4', 'radius', 'dx', 'dy', 'baseFrequency', 'numOctaves', 'seed', 'stitchTiles', 'scale',
  'xChannelSelector', 'yChannelSelector', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'surfaceScale', 'specularConstant', 'specularExponent', 'diffuseConstant', 'lighting-color', 'azimuth', 'elevation', 'z', 'pointsAtX', 'pointsAtY', 'pointsAtZ',
  'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'marker-start', 'marker-mid', 'marker-end', 'overflow', 'visibility', 'display', 'paint-order', 'vector-effect', 'shape-rendering', 'text-rendering', 'color-interpolation', 'color-interpolation-filters',
  'href', 'xlink:href', 'role', 'lang', 'xml:space', 'xml:lang', 'focusable', 'tabindex']);
const SVG_ATTR_PREFIX = /^(aria-|data-)[\w-]+$/;
const TAG = /<\/?([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
/** HTML-/XML-Entities auflösen (auch ohne Semikolon), damit „&#106;avascript:“ erkannt wird */
const decodeEntities = (s: string) => s.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&(lt|gt|amp|quot|apos|colon|tab|newline|nbsp|sol);?/gi, (_, n: string) => NAMED[n.toLowerCase()] ?? _);
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ', sol: '/' };
const unquote = (v: string | undefined) => (v == null ? '' : /^["']/.test(v) ? v.slice(1, -1) : v);
// url(#id) ist erlaubt (Verläufe, Masken), jede andere url() nicht; data:/javascript:/@import nirgends
const BAD_VALUE = /url\(\s*["']?\s*(?!#)|@import|expression\(|-moz-binding|behavior\s*:|javascript:|vbscript:|data:\s*[a-z][\w.+-]*\/|</i;
const DENY = new RegExp(`<\\s*/?\\s*(script|foreignObject|set|animate\\w*|style|image|iframe|embed|object|a|handler|listener|audio|video|canvas|link|meta|base)\\b|\\bon[a-z]+\\s*=|${BAD_VALUE.source.replace('|<', '')}`, 'i');
export function sanitizeSvg(svg: string): string {
  let s = String(svg).trim().replace(/<!--[\s\S]*?-->/g, '');
  if (!/^<svg[\s>]/i.test(s)) throw new Error('SVG muss mit <svg beginnen');
  const reject = (why: string) => new Error(`SVG abgelehnt: ${why}. Erlaubt sind nur einfache Vektorgrafiken ohne Script, Event-Handler, Animation, <style>, <image> und externe Verweise.`);
  const flat = decodeEntities(s).replace(/[\t\n\r\0]/g, '');
  if (DENY.test(flat)) throw reject(`unzulässiger Inhalt (${DENY.exec(flat)?.[0].trim()})`);
  for (const m of s.matchAll(TAG)) {
    const [tag, name, attrs] = m;
    if (!SVG_ELEMENTS.has(name)) throw reject(`Element <${name}> nicht erlaubt`);
    if (tag.startsWith('</')) continue;
    for (const a of attrs.matchAll(ATTR)) {
      const an = a[1], lower = an.toLowerCase(), val = decodeEntities(unquote(a[2])).replace(/[\t\n\r\0]/g, '').trim();
      if (/^(on|ev:)/i.test(an)) throw reject(`Event-Handler ${an}`);
      if (!SVG_ATTRS.has(an) && !SVG_ATTRS.has(lower) && !SVG_ATTR_PREFIX.test(lower)) throw reject(`Attribut ${an} nicht erlaubt`);
      if (/href$/i.test(lower) && !/^#[\w:.-]+$/.test(val)) throw reject(`${an} darf nur auf ein Element im SVG zeigen (#id)`);
      if (BAD_VALUE.test(val)) throw reject(`Attributwert von ${an} (${val.slice(0, 40)})`);
    }
  }
  if (s.replace(TAG, '').includes('<')) throw reject('ungültiges Markup (Kommentare, CDATA, DOCTYPE oder nicht geschlossene Tags)');
  if (!/xmlns=/.test(s.slice(0, 300))) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s;
}

export const imageGenAvailable = () => !!rt().img.key;
export async function generateRaster(prompt: string, size = '1536x1024'): Promise<Buffer> {
  const { key, model } = rt().img;
  if (!key) throw new Error('Keine Bildgenerierung konfiguriert (OpenAI-Key in den Einstellungen fehlt). Alternativen: Bild hochladen, Shop-Medien nutzen oder create_svg_image für Grafiken.');
  // 429/5xx begrenzt wiederholen (max. 3 Versuche, Retry-After beachtet); Basis-URL nur für Tests überschreibbar (LOTSE_OPENAI_API_BASE)
  const url = `${(process.env.LOTSE_OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '')}/images/generations`;
  const r = await fetchWithRetry(() => fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || 'gpt-image-1', prompt, size, n: 1 }), signal: AbortSignal.timeout(180_000),
  }));
  const j = await r.json().catch(() => ({})) as { error?: { message?: string }; data?: { b64_json?: string; url?: string }[] };
  if (!r.ok) throw new Error(`Bildgenerierung fehlgeschlagen (${r.status}): ${j.error?.message ?? 'unbekannt'}`);
  const d = j.data?.[0];
  if (d?.b64_json) return Buffer.from(d.b64_json, 'base64');
  if (d?.url) return Buffer.from(await (await fetch(d.url)).arrayBuffer());
  throw new Error('Bildgenerierung lieferte kein Bild');
}
