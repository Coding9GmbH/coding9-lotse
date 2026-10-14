import 'server-only';
// Media: import by URL (server-side download), file upload, SVG creation, optional AI image generation → Shopware media library
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
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

// Runtime configuration (runtime.ts sets it after every settings change)
const rt = () => singleton('media', () => ({ fetch: fetch as Fetcher, publicFetch: ((u, i) => pinnedFetch(u, { headers: i?.headers as Record<string, string>, signal: i?.signal ?? undefined })) as Fetcher, img: { key: '', model: '' }, origins: (async () => []) as () => Promise<string[]> }));
export const setFetcher = (f: Fetcher) => { rt().fetch = f; };
/** Tests only: replace fetch for foreign (not own) hosts; default is pinnedFetch */
export const setPublicFetcher = (f: Fetcher) => { rt().publicFetch = f; };
export const setImageConfig = (c: { key: string; model: string }) => { rt().img = c; };
/** Additional trusted shop addresses (e.g. sales channel domains), in addition to the URLs from settings */
export const setTrustedOrigins = (f: () => Promise<string[]>) => { rt().origins = f; };

// ---- Protection against access to the internal network (SSRF): the AI may only load images from its own shop or the public internet ----
const originOf = (u: string) => { try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).origin; } catch { return null; } };
const toOrigins = (urls: string[]) => new Set(urls.map(originOf).filter((o): o is string => !!o));
/** Fully trusted: only the shop URLs entered in settings (localhost/host.docker.internal is allowed there too) */
const settingsOrigins = () => {
  const g = getSettings(), urls: string[] = [];
  for (const k of PLATFORM_KINDS) for (const [key, v] of Object.entries(platformConfig(k, g))) if (/url|domain/i.test(key) && v) urls.push(v);
  return toOrigins(urls);
};
/** Addresses of the connected shop (platform URLs from settings + runtime sales channel domains) */
export async function trustedOrigins(): Promise<Set<string>> {
  return new Set([...settingsOrigins(), ...toOrigins(await rt().origins().catch(() => []))]);
}
const privateV4 = (ip: string) => { const [a, b] = ip.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || a === 192 && b === 168; };
/** IPv4 from IPv4-mapped IPv6 (::ffff:1.2.3.4 or, normalized by URL, ::ffff:a00:1), otherwise null */
const mappedV4 = (v: string) => {
  const m4 = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/), mh = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m4) return m4[1];
  if (mh) { const hi = parseInt(mh[1], 16), lo = parseInt(mh[2], 16); return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  return null;
};
/** Loopback, private networks, link-local (cloud metadata), CGNAT, IPv6 counterparts and IPv4-mapped */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v = ip.toLowerCase().replace(/^\[|\]$/g, ''), m = mappedV4(v);
  if (m) return privateV4(m);
  return v === '::' || v === '::1' || /^f[cd][0-9a-f]{2}:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v);
}
/** Link-local/cloud metadata (169.254.0.0/16, fe80::/10, AWS fd00:ec2::254): never allowed, not even for sales channel domains */
export function isMetadataIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, ''), v4 = net.isIPv4(v) ? v : mappedV4(v);
  if (v4) return v4.startsWith('169.254.');
  return /^fe[89ab][0-9a-f]:/.test(v) || v === 'fd00:ec2::254';
}
const LOCAL_MSG = 'interne oder lokale Adressen sind nicht erlaubt (nur der eigene Shop oder öffentliche Bild-URLs)';
/** Only http(s) to public addresses; host names are resolved so "localhost" or an internal DNS name doesn't slip through */
export async function assertPublicUrl(url: string): Promise<void> {
  let u: URL; try { u = new URL(url); } catch { throw new Error(`${url} ist keine gültige URL`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${url}: nur http(s)-Adressen`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(a => a.address);
  if (!addrs.length) throw new Error(`${url}: Host nicht auflösbar`);
  if (addrs.some(isPrivateIp)) throw new Error(`${url}: ${LOCAL_MSG}`);
}
type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;
type LookupCb = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;
/** DNS resolution for the socket itself: EVERY resolved address is checked (no DNS rebinding between check and connection) */
export const pinnedLookup = (resolve: LookupAll = h => dns.lookup(h, { all: true })) => (host: string, opts: { all?: boolean } | number | undefined, cb: LookupCb) => {
  resolve(host).then(addrs => {
    if (!addrs.length) throw Object.assign(new Error(`${host}: Host nicht auflösbar`), { code: 'ENOTFOUND' });
    if (addrs.some(a => isPrivateIp(a.address))) throw Object.assign(new Error(`${host}: ${LOCAL_MSG}`), { code: 'EPRIVATE' });
    if (typeof opts === 'object' && opts?.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
  }).catch((e: NodeJS.ErrnoException) => cb(e, ''));
};
/** fetch for foreign hosts: node:http(s) with checked DNS resolution, without redirects (the caller checks those one by one) */
export function pinnedFetch(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}, lookup = pinnedLookup()): Promise<Response> {
  const u = new URL(url), mod = u.protocol === 'https:' ? https : http;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateIp(host)) return Promise.reject(new Error(`${url}: ${LOCAL_MSG}`)); // IP literal: no lookup
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: 'GET', headers: { ...init.headers, 'accept-encoding': 'identity' }, signal: init.signal, lookup: lookup as unknown as typeof dns.lookup }, res => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const x of [v].flat()) h.append(k, x);
      const status = res.statusCode ?? 502, empty = [101, 204, 205, 304].includes(status);
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: h }));
    });
    req.on('error', reject);
    req.end();
  });
}
/** Read the response body with a limit: Content-Length up front, counted continuously while streaming (no unbounded arrayBuffer()) */
export async function readCapped(r: Response, max = MAX): Promise<Buffer> {
  const too = () => new Error(`Bild größer als ${Math.round(max / 1024 / 1024)} MB`);
  if (Number(r.headers.get('content-length') || 0) > max) { await r.body?.cancel().catch(() => {}); throw too(); }
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader(), parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); throw too(); }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
const REDIRECT = new Set([301, 302, 303, 307, 308]);
export async function downloadImage(url: string) {
  const own = settingsOrigins(), channel = toOrigins(await rt().origins().catch(() => []));
  let cur = url;
  for (let hop = 0; ; hop++) {
    const o = originOf(cur) ?? '', ownHost = own.has(o), chHost = !ownHost && channel.has(o), trusted = ownHost || chHost;
    if (!trusted) await assertPublicUrl(cur);
    else if (chHost) { // sales channel domain: internal addresses ok (Docker), cloud metadata never
      const h = new URL(cur).hostname.replace(/^\[|\]$/g, '');
      const addrs = net.isIP(h) ? [h] : (await dns.lookup(h, { all: true }).catch(() => [])).map(a => a.address);
      if (addrs.some(isMetadataIp)) throw new Error(`${cur}: ${LOCAL_MSG}`);
    }
    // foreign hosts: no status/error code to the AI (otherwise a reachability oracle), redirects are checked one by one (max. 3)
    const fail = (detail: string) => new Error(`Download von ${cur} fehlgeschlagen${trusted ? `: ${detail}` : ' (nicht erreichbar oder kein Bild)'}`);
    const init = { redirect: 'manual' as const, headers: { 'user-agent': 'Mozilla/5.0 (Lotse)', accept: 'image/*' }, signal: AbortSignal.timeout(25_000) };
    let r: Response;
    try { r = await (trusted ? rt().fetch(cur, init) : rt().publicFetch(cur, init)); }
    catch (e) { throw fail(errMsg(e)); }
    if (REDIRECT.has(r.status)) {
      const loc = r.headers.get('location'); await r.body?.cancel().catch(() => {});
      if (!loc || hop >= 3) throw fail('zu viele Weiterleitungen');
      cur = new URL(loc, cur).href; continue;
    }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw fail(`HTTP ${r.status}`); }
    const mime = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) { await r.body?.cancel().catch(() => {}); throw new Error(`${cur} ist kein Bild (Content-Type: ${mime || 'unbekannt'})`); }
    return { buf: await readCapped(r), mime };
  }
}
const IMPORT_MAP = 'import_map';
export async function importFromUrl(sw: Shopware, url: string, { alt, name, folder }: { alt?: string; name?: string; folder?: string } = {}) { // writes: only in the executor after approval
  const known = kvGet<Record<string, string>>(IMPORT_MAP)?.[url];
  const row = known ? await sw.get('media', known).catch(() => null) : null;
  if (known && row) return { mediaId: known, url: row.url, fileName: `${row.fileName}.${row.fileExtension}`, alt: alt ?? row.alt ?? null };
  const { buf, mime } = await downloadImage(url);
  const up = await uploadBuffer(sw, buf, mime, { name: name ?? (new URL(url).pathname.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/i, ''), alt, folder });
  kvSet(IMPORT_MAP, { ...(kvGet<Record<string, string>>(IMPORT_MAP) ?? {}), [url]: up.mediaId });
  return up;
}

// ---- Staging: the AI's images live ONLY locally (data/staging) until a publication is approved ----
export const stageDir = () => path.join(dataDir(), 'staging');
const readMap = () => kvGet<Record<string, string>>('staging_map') ?? {};
/** ai: generated by the image AI; must be labeled as AI-generated on the page and in media management */
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
/** IDs of all staged AI images that occur in a text/JSON ("/staged/<id>.png" or "staged:<id>"). */
export function aiImageIds(text: string): string[] {
  const ids = new Set([...text.matchAll(/(?:\/staged\/|staged:)([a-z0-9]+)/g)].map(m => m[1]));
  return [...ids].filter(id => stagedMeta(id)?.ai);
}

// AI images from the shop's media management: detected by title/alt text/file name, remembered via the URL path
const AI_MEDIA = /\bKI[- ]?generiert|\bAI[- ]?generated|\bki-bild/i;
const aiMediaPaths = () => singleton('aiMediaPaths', () => new Set<string>());
// Compare from "/media/" on, so the same file is recognized via shop domain, proxy (/shop/…) or thumbnail path
const pathOf = (url: string) => { let p = url; try { p = new URL(url, 'http://x').pathname; } catch { /* relative */ } const i = p.indexOf('/media/'); return i >= 0 ? p.slice(i) : p; };
/** Remembers a shop medium as an AI image if it is labeled as such; returns true for AI images. */
export function noteMedia(m: { url?: string | null; title?: string | null; alt?: string | null; fileName?: string | null } | null | undefined): boolean {
  if (!m?.url || !AI_MEDIA.test(`${m.title ?? ''} ${m.alt ?? ''} ${m.fileName ?? ''}`)) return false;
  aiMediaPaths().add(pathOf(m.url));
  return true;
}
/** Is this image URL AI-generated (staged AI image or shop medium labeled as AI)? */
export const isAiImageUrl = (url: string) => aiImageIds(url).length > 0 || aiMediaPaths().has(pathOf(url));
/** All AI images in a text/JSON (staged and known shop media). */
export function aiImagesIn(text: string): string[] {
  return [...aiImageIds(text), ...[...aiMediaPaths()].filter(p => text.includes(p))];
}
export const AI_CREDIT = 'Bild: KI-generiert';
/** Read a staged image (e.g. for the AI to look at). */
export function readStaged(id: string): { buf: Buffer; mime: string; name: string } | null {
  const m = stagedMeta(id); if (!m) return null;
  return { buf: fs.readFileSync(path.join(stageDir(), m.file)), mime: m.mime, name: m.name };
}
export async function uploadStaged(sw: Shopware, id: string, { folder }: { folder?: string } = {}): Promise<string> { // writes: only in the executor after approval
  const map = readMap(); if (map[id] && await sw.get('media', map[id]).catch(() => null)) return map[id]; // already uploaded and still present: not twice
  const meta = stagedMeta(id); if (!meta) throw new Error(`Vorgemerktes Bild ${id} nicht gefunden`);
  const up = await uploadBuffer(sw, fs.readFileSync(path.join(stageDir(), meta.file)), meta.mime,
    meta.ai ? { name: `ki-${meta.name}`, alt: meta.alt, title: `KI-generiert: ${meta.alt ?? meta.name}`, folder } : { name: meta.name, alt: meta.alt, folder });
  kvSet('staging_map', { ...readMap(), [id]: up.mediaId }); return up.mediaId;
}

/** Serving staged images: only image files directly in the staging folder (no path escape). */
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

// ---- Check the AI's SVG: no script, no event handlers, no animations/styles, no external references ----
// Don't "sanitize" (stripping can be bypassed via entity encoding, tag splitting or unquoted attributes), REJECT instead:
// after approval the file ends up unchanged in media management and is served by the shop without CSP.
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
/** Decode HTML/XML entities (even without semicolon) so "&#106;avascript:" is detected */
const decodeEntities = (s: string) => s.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&(lt|gt|amp|quot|apos|colon|tab|newline|nbsp|sol);?/gi, (_, n: string) => NAMED[n.toLowerCase()] ?? _);
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ', sol: '/' };
const unquote = (v: string | undefined) => (v == null ? '' : /^["']/.test(v) ? v.slice(1, -1) : v);
// url(#id) is allowed (gradients, masks), any other url() is not; data:/javascript:/@import nowhere
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
  // Retry 429/5xx a limited number of times (max. 3 attempts, Retry-After respected); base URL overridable for tests only (LOTSE_OPENAI_API_BASE)
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
