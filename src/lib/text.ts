// Text helpers without platform dependency.

/** URL slug/handle: lowercase, ä→ae ö→oe ü→ue ß→ss, accents removed, everything else to hyphens, truncated to max characters */
export const slugify = (s: unknown, max = 255) => String(s ?? '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
