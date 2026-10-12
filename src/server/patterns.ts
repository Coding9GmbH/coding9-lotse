import 'server-only';
// Design-Patterns: geprüfte, responsive, barrierearme Sektionen als custom-html (nutzen die --sg-* Styleguide-Variablen)
import { wrapCustom, type BlockSpec, type PageSpec } from './cms';
import { AI_CREDIT, isAiImageUrl } from './media';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c as '&' | '<' | '>' | '"']));
const href = (u: unknown) => (/^(\/|#|https?:\/\/|mailto:|tel:)/.test(String(u ?? '')) ? esc(u) : '#');
// Pattern-Daten kommen frei von der KI → bewusst lose typisiert
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const arr = (v: unknown): any[] => (Array.isArray(v) ? v.filter(Boolean) : []);

const ICONS: Record<string, string> = { // Feather-Stil, 24x24, stroke
  check: '<path d="M20 6 9 17l-5-5"/>', truck: '<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', award: '<circle cx="12" cy="8" r="7"/><path d="M8.21 13.89 7 23l5-3 5 3-1.21-9.12"/>',
  headset: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  gift: '<path d="M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
};
const icon = (n: string, cls = 'ic') => `<span class="${cls}" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] ?? ICONS.check}</svg></span>`;

/** Sichtbare Kennzeichnung für Bilder der Bild-KI (data.imageAi oder automatisch erkannt) */
const credit = (d: Data) => (d.imageAi === true || (typeof d.imageUrl === 'string' && isAiImageUrl(d.imageUrl)) ? `<p class="credit">${AI_CREDIT}</p>` : '');

const BASE = `.scope{--p:var(--sg-primary,#0042a0);--pc:var(--sg-primary-contrast,#fff);--a:var(--sg-accent,var(--p));--t:var(--sg-text,#1e1e1e);--m:var(--sg-muted,#5b6670);--s:var(--sg-surface,#f4f6f8);--b:var(--sg-border,#e2e7ec);--r:var(--sg-radius,12px);color:var(--t);line-height:1.6}

.scope>section{text-align:start;font-size:1rem} /* Theme-Klassen wie .hero/.split dürfen das Muster nicht umstylen */
.scope *{box-sizing:border-box}.scope h1,.scope h2,.scope h3{font-family:var(--sg-font-heading,inherit);line-height:1.1;margin:0 0 .4em;letter-spacing:-.02em;color:inherit;text-wrap:balance}
.scope h2{font-size:clamp(1.7rem,3.2vw,2.6rem)}.scope h3{font-size:1.15rem;letter-spacing:-.01em}.scope p{margin:0 0 .8em;text-wrap:pretty}.scope .lead{font-size:clamp(1.05rem,1.4vw,1.2rem);color:var(--m);max-width:60ch}
.scope .credit{font-size:.75rem;color:var(--m);margin:1.2em 0 0;letter-spacing:.01em}.scope .band .credit,.scope .hero.image .credit{color:inherit;opacity:.8}
.scope .eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:.76rem;font-weight:600;color:var(--m);margin:0 0 1em}
.scope .btn{display:inline-flex;align-items:center;gap:.55em;padding:.95em 1.6em;border-radius:var(--r);background:var(--p);color:var(--pc);font-weight:600;text-decoration:none;transition:filter .15s;border:0;cursor:pointer}
.scope .btn:hover{filter:brightness(.92);text-decoration:none;color:var(--pc)}.scope .btn svg{width:1.1em;height:1.1em;transition:transform .15s}.scope .btn:hover svg{transform:translateX(3px)}
.scope .link{color:var(--p);font-weight:600;text-decoration:underline;text-underline-offset:.25em;text-decoration-thickness:1px}.scope .link:hover{text-decoration-thickness:2px}
.scope a:focus-visible,.scope summary:focus-visible,.scope .btn:focus-visible{outline:3px solid var(--a);outline-offset:3px}
.scope .ic{display:inline-grid;place-items:center;width:28px;height:28px;color:var(--p);flex:none}.scope .ic svg{width:24px;height:24px}
.scope .media{width:100%;height:100%;object-fit:cover;border-radius:var(--r);display:block}
@media(prefers-reduced-motion:reduce){.scope *{transition:none!important;animation:none!important}}`;

interface PatternOut { html: string; css: string; js?: string }
export const PATTERNS: Record<string, { desc: string; build: (d: Data) => PatternOut }> = {
  hero: {
    desc: 'Einstieg mit EINEM H1, Subline, Haupt-CTA (+ optional Textlink). Mit Bild standardmäßig redaktioneller Split (großes Bild rechts). data: {eyebrow?, title, subtitle, ctaText, ctaHref, secondaryText?, secondaryHref?, imageUrl?, imageAlt?, variant?: "split"|"image"|"plain"|"solid"}. "image" = Vollbild mit Text darauf (nur bei ruhigem, kontrastreichem Foto), "solid" = Fläche in Primärfarbe (zählt als der eine farbige Abschnitt); image und split brauchen imageUrl, sonst wird plain gebaut',
    build: d => {
      const wanted = ['split', 'image', 'plain', 'solid'].includes(d.variant) ? d.variant : d.imageUrl ? 'split' : 'plain';
      const v = (wanted === 'image' || wanted === 'split') && !d.imageUrl ? 'plain' : wanted; // Bildvariante ohne Bild wäre weiße Schrift auf weißer Fläche
      return {
        css: `.scope .hero{display:grid;gap:clamp(24px,5vw,72px);align-items:center;padding:clamp(28px,5vw,72px) 0}
.scope .hero h1{font-size:clamp(2.3rem,5.4vw,4.2rem);margin-bottom:.3em;max-width:16ch}.scope .hero .sub{font-size:clamp(1.08rem,1.6vw,1.3rem);color:var(--m);max-width:48ch;margin-bottom:1.6em}
.scope .hero .cta{display:flex;gap:22px;align-items:center;flex-wrap:wrap}
.scope .hero.split{grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)}.scope .hero.split .pic{aspect-ratio:4/3.4}.scope .hero.split h1{font-size:clamp(2.2rem,4.2vw,3.5rem)}
.scope .hero.plain{padding-block:clamp(36px,7vw,110px)}
.scope .hero.solid{background:var(--p);color:var(--pc);border-radius:var(--r);padding:clamp(32px,6vw,88px)}.scope .hero.solid .sub,.scope .hero.solid .eyebrow{color:inherit;opacity:.85}.scope .hero.solid .btn{background:var(--pc);color:var(--p)}.scope .hero.solid .link{color:inherit}
.scope .hero.image{position:relative;min-height:clamp(380px,60vh,640px);align-items:end;padding:clamp(28px,5vw,64px);border-radius:var(--r);overflow:hidden;color:#fff}
.scope .hero.image .pic{position:absolute;inset:0;border-radius:0}.scope .hero.image::before{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgb(0 0 0/.62),rgb(0 0 0/.08) 60%);z-index:1}
.scope .hero.image .txt{position:relative;z-index:2}.scope .hero.image .sub,.scope .hero.image .eyebrow{color:#fff;opacity:.9}.scope .hero.image .link{color:#fff}
@media(max-width:760px){.scope .hero.split{grid-template-columns:1fr}.scope .hero.split .pic{order:-1;aspect-ratio:4/3}}`,
        html: `<section class="hero ${v}"><div class="txt">${d.eyebrow ? `<p class="eyebrow">${esc(d.eyebrow)}</p>` : ''}<h1>${esc(d.title)}</h1>${d.subtitle ? `<p class="sub">${esc(d.subtitle)}</p>` : ''}<div class="cta"><a class="btn" href="${href(d.ctaHref)}">${esc(d.ctaText)} ${icon('arrow', '')}</a>${d.secondaryText ? `<a class="link" href="${href(d.secondaryHref)}">${esc(d.secondaryText)}</a>` : ''}</div>${credit(d)}</div>${d.imageUrl && v !== 'plain' && v !== 'solid' ? `<img class="media pic" src="${esc(d.imageUrl)}" alt="${esc(d.imageAlt ?? '')}" loading="eager" fetchpriority="high">` : ''}</section>`,
      };
    },
  },
  split: {
    desc: 'Redaktioneller Bild-Text-Split (Storytelling, Produktdetail, Material). Großes Bild, Text daneben, optional 2 bis 4 Stichpunkte und Textlink. Für Abwechslung side wechseln. data: {eyebrow?, title, text, points?:[string], imageUrl, imageAlt, side?: "left"|"right", ctaText?, ctaHref?}',
    build: d => ({
      css: `.scope .split{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:clamp(24px,5vw,72px);align-items:center;padding:clamp(20px,4vw,48px) 0}
.scope .split.right .pic{order:2}.scope .split .pic{aspect-ratio:4/3.2}.scope .split .txt p{color:var(--m);max-width:56ch}
.scope .split ul{list-style:none;padding:0;margin:1.2em 0;display:grid;gap:.7em}.scope .split li{display:flex;gap:.7em;align-items:baseline}.scope .split li::before{content:"";width:.5em;height:.5em;border-radius:50%;background:var(--p);flex:none;transform:translateY(-.1em)}
@media(max-width:760px){.scope .split{grid-template-columns:1fr}.scope .split.right .pic{order:0}}`,
      html: `<section class="split ${d.side === 'right' ? 'right' : 'left'}"><img class="media pic" src="${esc(d.imageUrl)}" alt="${esc(d.imageAlt ?? '')}" loading="lazy"><div class="txt">${d.eyebrow ? `<p class="eyebrow">${esc(d.eyebrow)}</p>` : ''}<h2>${esc(d.title)}</h2><p>${esc(d.text)}</p>${arr(d.points).length ? `<ul>${arr(d.points).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${d.ctaText ? `<a class="link" href="${href(d.ctaHref)}">${esc(d.ctaText)}</a>` : ''}${credit(d)}</div></section>`,
    }),
  },
  band: {
    desc: 'Bildband über die volle Breite mit kurzer Aussage, ideal als EIN Signatur-Moment. data: {imageUrl, imageAlt, title, text?} (title ≤ 8 Wörter; ruhiges Foto mit Freifläche)',
    build: d => ({
      css: `.scope .band{position:relative;border-radius:var(--r);overflow:hidden;min-height:clamp(300px,48vh,520px);display:grid;align-items:end;color:#fff}
.scope .band .pic{position:absolute;inset:0;border-radius:0}.scope .band::before{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgb(0 0 0/.55),transparent 65%);z-index:1}
.scope .band .txt{position:relative;z-index:2;padding:clamp(24px,5vw,56px);max-width:40ch}.scope .band h2{font-size:clamp(1.9rem,4vw,3.2rem)}.scope .band p{opacity:.9;margin:0}`,
      html: `<section class="band"><img class="media pic" src="${esc(d.imageUrl)}" alt="${esc(d.imageAlt ?? '')}" loading="lazy"><div class="txt"><h2>${esc(d.title)}</h2>${d.text ? `<p>${esc(d.text)}</p>` : ''}${credit(d)}</div></section>`,
    }),
  },
  'usp-bar': {
    desc: 'Ruhige Vorteils-/Trust-Leiste (3 bis 4 belegte Punkte) direkt unter dem Einstieg. data: {items:[{icon, title, text?}]}. icon ∈ ' + Object.keys(ICONS).join(', '),
    build: d => ({
      css: `.scope .usp ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0;list-style:none;margin:0;padding:0;border-block:1px solid var(--b)}
.scope .usp li{display:flex;gap:12px;align-items:flex-start;padding:18px clamp(12px,2vw,22px)}.scope .usp li+li{border-left:1px solid var(--b)}.scope .usp b{display:block;font-weight:600}.scope .usp small{color:var(--m);font-size:.88rem;line-height:1.4;display:block}
@media(max-width:700px){.scope .usp li+li{border-left:0;border-top:1px solid var(--b)}}`,
      html: `<section class="usp" aria-label="Vorteile"><ul>${arr(d.items).map(i => `<li>${icon(i.icon)}<span><b>${esc(i.title)}</b>${i.text ? `<small>${esc(i.text)}</small>` : ''}</span></li>`).join('')}</ul></section>`,
    }),
  },
  benefits: {
    desc: 'Nutzen in 3 bis 6 Punkten (Titel als Aussage, Text mit Beleg). Ruhiges Raster mit Trennlinien statt Kartenstapel. data: {eyebrow?, title, intro?, items:[{icon?, title, text}]}',
    build: d => ({
      css: `.scope .ben .head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:clamp(16px,4vw,56px);align-items:end;margin-bottom:clamp(20px,3vw,36px)}.scope .ben .head .lead{margin:0}
.scope .ben .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:clamp(20px,3vw,40px)}
.scope .ben article{border-top:1px solid var(--b);padding-top:18px}.scope .ben article .ic{margin-bottom:10px}.scope .ben article p{color:var(--m);margin:0}
@media(max-width:760px){.scope .ben .head{grid-template-columns:1fr}}`,
      html: `<section class="ben"><div class="head"><div>${d.eyebrow ? `<p class="eyebrow">${esc(d.eyebrow)}</p>` : ''}<h2>${esc(d.title)}</h2></div>${d.intro ? `<p class="lead">${esc(d.intro)}</p>` : '<span></span>'}</div><div class="grid">${arr(d.items).map(i => `<article>${i.icon ? icon(i.icon) : ''}<h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></article>`).join('')}</div></section>`,
    }),
  },
  steps: {
    desc: 'Echte Reihenfolge (Kaufberatung, So funktioniert’s, Pflege). Große Ziffern, ruhige Spalten. data: {title, intro?, items:[{title, text}]}',
    build: d => ({
      css: `.scope .steps ol{counter-reset:s;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:clamp(20px,3vw,40px);padding:0;margin:clamp(18px,3vw,32px) 0 0;list-style:none}
.scope .steps li{counter-increment:s;border-top:2px solid var(--t);padding-top:16px}.scope .steps li::before{content:counter(s,decimal-leading-zero);display:block;font:600 clamp(1.6rem,3vw,2.2rem)/1 var(--sg-font-heading,inherit);color:var(--p);margin-bottom:14px;font-variant-numeric:tabular-nums}.scope .steps li p{color:var(--m);margin:0}`,
      html: `<section class="steps"><h2>${esc(d.title)}</h2>${d.intro ? `<p class="lead">${esc(d.intro)}</p>` : ''}<ol>${arr(d.items).map(i => `<li><h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></li>`).join('')}</ol></section>`,
    }),
  },
  faq: {
    desc: 'FAQ-Akkordeon (details/summary, barrierefrei) MIT Schema.org-FAQPage-JSON-LD. data: {title, items:[{q, a}]} (5 bis 8 echte Fragen mit Suchintention, Antworten 40 bis 90 Wörter)',
    build: d => {
      const items = arr(d.items);
      const ld = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map(i => ({ '@type': 'Question', name: i.q, acceptedAnswer: { '@type': 'Answer', text: i.a } })) };
      return {
        css: `.scope .faq{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.4fr);gap:clamp(20px,5vw,72px);align-items:start}.scope .faq .list{border-top:1px solid var(--b)}
.scope .faq details{border-bottom:1px solid var(--b)}.scope .faq summary{cursor:pointer;list-style:none;padding:20px 44px 20px 0;font-weight:600;font-size:1.05rem;position:relative}
.scope .faq summary::-webkit-details-marker{display:none}.scope .faq summary::after{content:"+";position:absolute;right:4px;top:50%;transform:translateY(-50%);font-size:1.5rem;font-weight:400;color:var(--p);transition:transform .2s}
.scope .faq details[open] summary::after{transform:translateY(-50%) rotate(45deg)}.scope .faq .a{padding:0 0 20px;color:var(--m);max-width:62ch}
@media(max-width:760px){.scope .faq{grid-template-columns:1fr}}`,
        html: `<section class="faq"><h2>${esc(d.title)}</h2><div class="list">${items.map((i, n) => `<details${n === 0 ? ' open' : ''}><summary>${esc(i.q)}</summary><div class="a"><p>${esc(i.a)}</p></div></details>`).join('')}</div></section><script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
        js: `root.querySelectorAll('.faq details').forEach(function(d){d.addEventListener('toggle',function(){if(d.open)root.querySelectorAll('.faq details[open]').forEach(function(o){if(o!==d)o.open=false})})})`,
      };
    },
  },
  comparison: {
    desc: 'Vergleichstabelle (scrollbar auf Mobile, hebt eine Spalte hervor). data: {title, intro?, columns:[string], rows:[[string]], highlight?: Spaltenindex ab 1}',
    build: d => {
      // Zeilen sind Arrays (anderes kommt von der KI vor und darf nicht abstürzen); Beschriftung in Spalte 1, aber Kopf ohne leere Ecke → Ecke ergänzen
      const rows = (arr(d.rows) as unknown[]).filter((r): r is unknown[] => Array.isArray(r)), cols = arr(d.columns);
      if (rows.length && rows.every(r => r.length === cols.length + 1)) cols.unshift('');
      return {
      css: `.scope .cmp .wrap{overflow-x:auto;border:1px solid var(--b);border-radius:var(--r)}.scope table{width:100%;border-collapse:collapse;min-width:520px}.scope th,.scope td{padding:14px 16px;text-align:left;border-bottom:1px solid var(--b)}
.scope thead th{background:var(--s);font-family:var(--sg-font-heading,inherit)}.scope tbody tr:last-child td{border-bottom:0}.scope .hl{background:color-mix(in srgb,var(--p) 8%,transparent);font-weight:600}`,
      html: `<section class="cmp"><h2>${esc(d.title)}</h2>${d.intro ? `<p class="lead">${esc(d.intro)}</p>` : ''}<div class="wrap" tabindex="0" role="region" aria-label="${esc(d.title)}"><table><thead><tr>${cols.map((c, i) => `<th scope="col"${i === d.highlight ? ' class="hl"' : ''}>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td${i === d.highlight ? ' class="hl"' : ''}>${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div></section>`,
      };
    },
  },
  'cta-banner': {
    desc: 'Abschluss mit einer klaren Handlung. data: {title, text?, ctaText, ctaHref, variant?: "plain"|"solid"}. "solid" = Fläche in Primärfarbe (nur wenn sonst kein farbiger Abschnitt)',
    build: d => ({
      css: `.scope .ctab{display:flex;gap:clamp(16px,4vw,48px);align-items:flex-end;justify-content:space-between;flex-wrap:wrap;padding:clamp(28px,5vw,64px) 0;border-top:1px solid var(--b)}
.scope .ctab h2{margin-bottom:.15em;max-width:22ch}.scope .ctab p{margin:0;color:var(--m);max-width:52ch}
.scope .ctab.solid{background:var(--p);color:var(--pc);border:0;border-radius:var(--r);padding:clamp(28px,5vw,64px)}.scope .ctab.solid p{color:inherit;opacity:.85}.scope .ctab.solid .btn{background:var(--pc);color:var(--p)}`,
      html: `<section class="ctab ${d.variant === 'solid' ? 'solid' : 'plain'}"><div><h2>${esc(d.title)}</h2>${d.text ? `<p>${esc(d.text)}</p>` : ''}</div><a class="btn" href="${href(d.ctaHref)}">${esc(d.ctaText)} ${icon('arrow', '')}</a></section>`,
    }),
  },
  facts: {
    desc: 'Kennzahlen, NUR mit belegten/vom Nutzer gelieferten Zahlen. data: {items:[{value, label}]}',
    build: d => ({
      css: `.scope .facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:clamp(16px,3vw,32px)}.scope .facts div{border-top:1px solid var(--b);padding-top:14px}
.scope .facts b{display:block;font:600 clamp(2rem,4vw,3rem)/1 var(--sg-font-heading,inherit);letter-spacing:-.03em;margin-bottom:.3em;font-variant-numeric:tabular-nums}.scope .facts span{color:var(--m);font-size:.92rem}`,
      html: `<section class="facts">${arr(d.items).map(i => `<div><b>${esc(i.value)}</b><span>${esc(i.label)}</span></div>`).join('')}</section>`,
    }),
  },
};

export const patternCatalog = () => Object.entries(PATTERNS).map(([k, v]) => `  · ${k}: ${v.desc}`).join('\n');

/** Namen von Pattern-Blöcken, die es im Katalog nicht gibt (Vertipper der KI): draft_page lehnt die Spec damit ab, statt Platzhalter zu bauen */
export const unknownPatterns = (spec: Partial<PageSpec>): string[] => [...new Set((spec.sections ?? []).flatMap(s => (s.blocks ?? []).filter(b => b?.type === 'pattern' && !PATTERNS[String(b.pattern ?? '')]).map(b => String(b.pattern ?? ''))))];

// {type:'pattern', pattern, data, ...} → {type:'custom-html', html, css, js}; unbekannte Patterns bleiben stehen (validateSpec meldet sie, die Vorschau zeigt einen Platzhalter)
export function expandSpec<T extends Partial<PageSpec>>(spec: T): T {
  return { ...spec, sections: (spec.sections ?? []).map(s => ({ ...s, blocks: (s.blocks ?? []).map((b): BlockSpec => {
    if (b?.type !== 'pattern') return b;
    const p = PATTERNS[b.pattern ?? ''];
    if (!p) return b;
    const out = p.build(b.data ?? {});
    return { type: 'custom-html', html: out.html, css: BASE + '\n' + out.css, js: out.js, _pattern: b.pattern, marginTop: b.marginTop, marginBottom: b.marginBottom, backgroundColor: b.backgroundColor };
  }) })) };
}

// Fertiges, eingebettetes HTML (inkl. Style/Script) eines Patterns, z.B. für produktindividuelle Inhalte im Zusatzfeld
export function renderPattern(name: string, data: Data) {
  const out = PATTERNS[name].build(data);
  return wrapCustom({ html: out.html, css: BASE + '\n' + out.css, js: out.js });
}
