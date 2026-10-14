import Link from 'next/link';
import { ago } from '@/lib/format';
import { exampleTagLabel, examples } from '@/lib/labels';
import { useI18n, useT } from '@/lib/i18n/I18nProvider';
import type { FixMap } from '@/lib/fixes';
import type { ChatSummary, CheckFinding, Health } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { ShopCheck } from './ShopCheck';
import { SistrixCard } from './SistrixCard';
import styles from './Home.module.css';

export function HomeHead() {
  const t = useT().chat.home;
  return (
    <div className={styles.head}>
      {/* eslint-disable-next-line @next/next/no-img-element -- CODING 9 Logo (SVG) */}
      <img src="/logo.svg" alt="CODING 9" width={56} height={56} />
      <h2>{t.title}</h2>
      <p>{t.lead}</p>
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
  const { locale, t: m } = useI18n(), t = m.chat.home;
  const needsSetup = !loadFailed && health && (!health.shopware.configured || !health.ai.configured);
  const ready = !loadFailed && health && health.shopware.configured && health.ai.configured;
  return (
    <div className={styles.home}>
      {loadFailed && (
        <div className={`${styles.card} ${styles.setup}`}>
          <b>{t.statusFailed}</b>
          <p>{t.statusFailedText}</p>
        </div>
      )}
      {needsSetup && (
        <div className={`${styles.card} ${styles.setup}`}>
          <b>{t.setupTitle}</b>
          <p>
            {!health.shopware.configured && !health.ai.configured ? t.setupBoth
              : !health.shopware.configured ? t.setupShop
                : t.setupAi}
          </p>
          <ul className={styles.check}>
            <li className={health.shopware.configured ? styles.done : undefined}>{t.connectShop}{health.platform ? ` (${health.platform.label})` : ''}</li>
            <li className={health.ai.configured ? styles.done : undefined}>{t.connectAi}</li>
          </ul>
          <Link href="/settings" className={styles.primaryLink}>{t.toSettings}</Link>
        </div>
      )}
      {hasStyleguide === false && ready && (
        <div className={`${styles.card} ${styles.cta}`}>
          <b>{t.sgTitle}</b>
          <p>{t.sgText}</p>
          <Button variant="primary" onClick={onOnboard}>{t.sgButton}</Button>
        </div>
      )}
      {ready && <ShopCheck onFix={onFix} fixes={fixes} onOpenChat={onOpenChat} onNewCheck={onExample} />}
      {ready && health?.integrations?.sistrix && <SistrixCard onAsk={onExample} />}
      <h3 className={styles.exH}>{t.tryIt}</h3>
      <div className={styles.ex}>
        {examples(product, category, locale, { gsc: health?.integrations?.gsc, sistrix: health?.integrations?.sistrix, shopware: health?.platform?.kind === 'shopware' }).map(e => (
          <button key={e.title} type="button" onClick={() => onExample(e.text)}>
            <span className={`${styles.tg} ${styles[`tg${e.tag}`]}`}>{exampleTagLabel(e.tag, locale)}</span>
            <b>{e.title}</b>
            <span className={styles.t}>{e.text}</span>
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <h3 className={styles.exH} style={{ marginTop: 22 }}>{t.recent}</h3>
          <div className={styles.recent}>
            {recent.slice(0, 4).map(c => (
              <button key={c.id} type="button" onClick={() => onOpenChat(c.id)}>
                <span>{c.title}</span>
                <small><time dateTime={c.updatedAt} suppressHydrationWarning>{ago(c.updatedAt, undefined, locale)}</time>{c.published ? ' · ✅' : ''}</small>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
