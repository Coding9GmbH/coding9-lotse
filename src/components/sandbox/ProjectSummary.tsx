'use client';

import type { CodeTaskPublic } from '@/lib/protocol';
import { useT } from '@/lib/i18n/I18nProvider';
import styles from './Sandbox.module.css';

/** A full Shopware project in the "Einrichtung" tab: its plugins (with what they bring), apps and theme, and what the sandbox does
 *  differently than the live shop (config files not loaded, services switched to local, packages the image lacks). */
export function ProjectSummary({ task }: { task: CodeTaskPublic }) {
  const t = useT().sandbox.project;
  const p = task.layout?.kind === 'project' ? task.layout.project : undefined;
  if (!p) return null;
  const q = p.quarantined ?? [];
  return (
    <section className={styles.projectBox} aria-labelledby="sbx-project-h">
      <h3 id="sbx-project-h" className={styles.label}>{t.heading}</h3>
      <p className={styles.fieldHint}>{p.install === 'full' ? t.leadFull : t.lead}</p>
      {task.layout?.root && <p className={styles.fieldHint}>{t.folder(task.layout.root)}</p>}
      <p className={styles.taskMeta}>{t.version(p.shopwareVersion)}{p.theme ? ` · ${t.theme(p.theme)}` : ''}</p>
      {p.plugins.length > 0 && (
        <div>
          <p className={styles.label}>{t.plugins}</p>
          <ul className={styles.projectList}>
            {p.plugins.map(x => (
              <li key={x.dir}><b>{x.name}</b>{x.theme ? ` · ${t.themeTag}` : ''}{x.static ? ` · ${t.static}` : ''}{x.label ? ` – ${x.label}` : ''}
                {x.parts.length > 0 && <span className={styles.muted}> ({x.parts.map(k => t.parts[k]).join(', ')})</span>}</li>
            ))}
          </ul>
        </div>
      )}
      {p.apps.length > 0 && <p className={styles.taskMeta}>{t.apps}: {p.apps.map(a => a.name).join(', ')}</p>}
      {q.length > 0 && (
        <details className={styles.projectWarn}>
          <summary>{t.quarantined(q.length)}</summary>
          <ul>{q.map(x => <li key={x.file}><code>{x.file}</code> – {t.reasons[x.code]?.(x.detail ?? '') ?? x.code}</li>)}</ul>
        </details>
      )}
      {(p.overrides ?? []).length > 0 && (
        <details>
          <summary>{t.overrides} ({p.overrides!.length})</summary>
          <ul className={styles.projectList}>{p.overrides!.map(o => <li key={o}><code>{o}</code></li>)}</ul>
        </details>
      )}
      {(p.envDefaults ?? []).length > 0 && <p className={styles.muted}>{t.envDefaults(p.envDefaults!.join(', '))}</p>}
      {(p.missingPackages ?? []).length > 0 && <p className={styles.muted}>{t.missing}: {p.missingPackages!.join(', ')}</p>}
    </section>
  );
}
