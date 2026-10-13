import Link from 'next/link';
import { ago } from '@/lib/format';
import { examples } from '@/lib/labels';
import type { FixMap } from '@/lib/fixes';
import type { ChatSummary, CheckFinding, Health } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { ShopCheck } from './ShopCheck';
import styles from './Home.module.css';

export function HomeHead() {
  return (
    <div className={styles.head}>
      {/* eslint-disable-next-line @next/next/no-img-element -- CODING 9 Logo (SVG) */}
      <img src="/logo.svg" alt="CODING 9" width={56} height={56} />
      <h2>Was möchtest du heute tun?</h2>
      <p>Schreib einfach, was im Shop passieren soll. Ich frage nach, zeige dir vorher eine Vorschau oder einen Vergleich und schreibe erst nach deiner Freigabe.</p>
    </div>
  );
}

interface Props {
  health: Health | null;
  /** Statusabruf fehlgeschlagen: nicht als „nicht verbunden“ und nicht als bereit zeigen. */
  loadFailed?: boolean;
  hasStyleguide: boolean | null;
  product: string;
  category: string;
  recent: ChatSummary[];
  onExample: (text: string) => void;
  /** Shop-Check-Befund als Auftrag ins Feld */
  onFix: (f: CheckFinding) => void;
  fixes: FixMap;
  onOpenChat: (id: string) => void;
  onOnboard: () => void;
}

/** Startbildschirm: Einrichtung, Styleguide-Empfehlung, Shop-Check, Beispiele, zuletzt genutzte Chats. */
export function HomeContent({ health, loadFailed = false, hasStyleguide, product, category, recent, onExample, onFix, fixes, onOpenChat, onOnboard }: Props) {
  const needsSetup = !loadFailed && health && (!health.shopware.configured || !health.ai.configured);
  const ready = !loadFailed && health && health.shopware.configured && health.ai.configured;
  return (
    <div className={styles.home}>
      {loadFailed && (
        <div className={`${styles.card} ${styles.setup}`}>
          <b>Status nicht geladen</b>
          <p>Ob Shop und KI verbunden sind, ist gerade nicht bekannt.</p>
        </div>
      )}
      {needsSetup && (
        <div className={`${styles.card} ${styles.setup}`}>
          <b>Lotse einrichten</b>
          <p>
            {!health.shopware.configured && !health.ai.configured ? 'Verbinde deinen Shop und die KI (ChatGPT-Abo oder Anthropic-API-Schlüssel), dann kann es losgehen.'
              : !health.shopware.configured ? 'Verbinde deinen Shop. Die KI ist schon bereit.'
                : 'Verbinde die KI (ChatGPT-Abo oder Anthropic-API-Schlüssel). Der Shop ist schon verbunden.'}
          </p>
          <ul className={styles.check}>
            <li className={health.shopware.configured ? styles.done : undefined}>Shop verbinden{health.platform ? ` (${health.platform.label})` : ''}</li>
            <li className={health.ai.configured ? styles.done : undefined}>KI verbinden</li>
          </ul>
          <Link href="/settings" className={styles.primaryLink}>Zu den Einstellungen</Link>
        </div>
      )}
      {hasStyleguide === false && ready && (
        <div className={`${styles.card} ${styles.cta}`}>
          <b>Empfehlung: erst den Styleguide anlegen</b>
          <p>Ich analysiere Theme, CSS, Logo und vorhandene Texte deines Shops. Danach passt alles zu deiner Marke.</p>
          <Button variant="primary" onClick={onOnboard}>Styleguide erstellen</Button>
        </div>
      )}
      {ready && <ShopCheck onFix={onFix} fixes={fixes} onOpenChat={onOpenChat} />}
      <h3 className={styles.exH}>Probier es aus</h3>
      <div className={styles.ex}>
        {examples(product, category).map(e => (
          <button key={e.title} type="button" onClick={() => onExample(e.text)}>
            <span className={`${styles.tg} ${styles[`tg${e.tag}`]}`}>{e.tag}</span>
            <b>{e.title}</b>
            <span className={styles.t}>{e.text}</span>
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <h3 className={styles.exH} style={{ marginTop: 22 }}>Zuletzt</h3>
          <div className={styles.recent}>
            {recent.slice(0, 4).map(c => (
              <button key={c.id} type="button" onClick={() => onOpenChat(c.id)}>
                <span>{c.title}</span>
                <small><time dateTime={c.updatedAt} suppressHydrationWarning>{ago(c.updatedAt)}</time>{c.published ? ' · ✅' : ''}</small>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
