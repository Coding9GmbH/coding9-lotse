import type { AppConfig, PublishedInfo, Styleguide, Target } from '@/lib/protocol';
import { swatches } from '@/lib/format';
import { adminUrl, asList } from '@/lib/urls';
import styles from './Cards.module.css';

/* eslint-disable @next/next/no-img-element -- Bilder aus Medienbibliothek/Vormerkung, Größen unbekannt */

export function ImageCard({ url, alt, fileName }: { url: string; alt: string; fileName: string }) {
  return (
    <div className={styles.imgcard}>
      <img src={url} alt={alt} />
      <span><b>Bild in Medienbibliothek</b><small>{fileName}{alt ? ` · ${alt}` : ''}</small></span>
    </div>
  );
}

export function PublishedCard({ info, target, cfg }: { info: PublishedInfo; target: Target | null; cfg: AppConfig | null }) {
  const links: { href: string; label: string }[] = [];
  const admin = cfg ?? { admin: '', storefront: '' };
  if (target?.kind === 'category' && target.id) links.push({ href: adminUrl(admin, 'category', target.id), label: 'Kategorie im Admin ↗' });
  if (target?.kind === 'product' && target.id) links.push({ href: adminUrl(admin, 'product', target.id), label: 'Produkt im Admin ↗' });
  if (info.adminUrl) links.push({ href: info.adminUrl, label: 'Layout im Admin ↗' });
  for (const u of asList(info.storefront)) links.push({ href: u, label: 'Storefront ↗' });
  if (info.url && !asList(info.storefront).includes(info.url)) links.push({ href: info.url, label: 'Seite ansehen ↗' });
  return (
    <div className={styles.pub} role="status">
      <b>✅ Veröffentlicht</b>
      <div className={styles.links}>
        {links.map(l => <a key={l.href + l.label} href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a>)}
      </div>
    </div>
  );
}

export function Swatches({ colors, n, size }: { colors: Styleguide['colors'] | undefined; n: number; size?: number }) {
  return (
    <span className={styles.sw} aria-hidden="true">
      {swatches(colors, n).map((c, i) => <i key={c + i} style={{ background: c, width: size, height: size }} />)}
    </span>
  );
}

export function StyleguideCard({ sg, onOpen }: { sg: Styleguide; onOpen: () => void }) {
  return (
    <div className={styles.sgcard}>
      <Swatches colors={sg.colors} n={6} size={18} />
      <span><b>Styleguide gespeichert</b><br />
        <button type="button" className={styles.link} onClick={onOpen}>Ansehen &amp; Farben anpassen</button>
      </span>
    </div>
  );
}
