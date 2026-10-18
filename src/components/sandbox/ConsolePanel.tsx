'use client';

import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { api, errorText, listenConsole } from '@/lib/api';
import { useT } from '@/lib/i18n/I18nProvider';
import { createLineSplitter } from '@/lib/ndjson';
import { CONSOLE_IDLE_MINUTES, CONSOLE_MAX, type CodeTaskPublic, type ConsoleCloseReason, type ConsoleEvent } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { IconClose } from '@/components/ui/icons';
import styles from './Sandbox.module.css';

/** Quick buttons: they only type the command (with Enter) into the current console, exactly as if the user had typed it. */
const QUICK = [
  { key: 'cache', cmd: 'bin/console cache:clear' },
  { key: 'theme', cmd: 'bin/console theme:compile' },
  { key: 'plugins', cmd: 'bin/console plugin:list' },
  { key: 'log', cmd: 'tail -n 50 -f var/log/*.log' },
] as const;
/** One POST of input stays below the server's 64 KB (a long paste goes in pieces, in order) */
const INPUT_PIECE = 16 * 1024;
/** A dark terminal in both themes, close to Lotse's colours */
const THEME = { background: '#1d1d24', foreground: '#e9e7e1', cursor: '#f0c674', selectionBackground: '#4a4a5a', black: '#2e2e38', brightBlack: '#6b6b76' };

type End = ConsoleCloseReason | 'gone';
interface Item { id: string; n: number; end: End | null }

const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

/**
 * Tab "Konsole": interactive shells in the sandbox's container for the user (never the AI). Each session is an xterm.js terminal fed
 * by an NDJSON stream (reconnects after a dropped connection and after a reload: the server keeps the session and replays its recent
 * output); keystrokes go out in order by POST, the size follows the panel. Up to CONSOLE_MAX sessions; the quick buttons type common
 * commands. Opening one wakes a paused sandbox. `active`: the tab is shown (terminals stay mounted while hidden, so nothing is lost).
 */
export function ConsolePanel({ task, active }: { task: CodeTaskPublic; active: boolean }) {
  const t = useT().sandbox.console;
  const [items, setItems] = useState<Item[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const typers = useRef(new Map<string, (text: string) => void>());
  const seq = useRef(0);

  // the user's sessions that are still open (after a reload): attach to them again
  useEffect(() => {
    let off = false;
    api.sandbox.consoles(task.id).then(r => {
      if (off) return;
      const list = r.sessions.map((x, i) => ({ id: x.id, n: i + 1, end: null }));
      seq.current = Math.max(seq.current, list.length);
      setItems(cur => (cur.length ? cur : list));
      setCurrent(c => c ?? list.at(-1)?.id ?? null);
    }, () => {}).finally(() => { if (!off) setLoaded(true); });
    return () => { off = true; };
  }, [task.id]);

  const live = items.filter(i => !i.end);
  const s = task.status;
  const usable = s !== 'done' && !task.stopping && (s === 'paused' || (!!task.container?.running && s !== 'waking'));

  async function open() {
    setOpening(true); setError(null);
    try {
      const { session } = await api.sandbox.openConsole(task.id, { cols: 100, rows: 30 }); // the terminal fits itself right after
      const n = ++seq.current; // outside the updater: React may call an updater twice
      setItems(cur => [...cur.filter(i => !i.end), { id: session.id, n, end: null }]);
      setCurrent(session.id);
    } catch (e) { setError(t.failed(errorText(e))); } finally { setOpening(false); }
  }
  async function close(id: string) {
    const ended = items.find(i => i.id === id)?.end;
    if (!ended) await api.sandbox.closeConsole(task.id, id).catch(() => {});
    const rest = items.filter(i => i.id !== id);
    setItems(cur => cur.filter(i => i.id !== id));
    setCurrent(c => (c === id ? rest.at(-1)?.id ?? null : c));
  }
  const onEnd = (id: string, end: End) => setItems(cur => cur.map(i => (i.id === id ? { ...i, end } : i)));
  const shown = items.find(i => i.id === current) ?? null;

  return (
    <div className={styles.conPanel}>
      <div className={styles.conBar}>
        <div className={styles.conTabs} role="tablist" aria-label={t.sessions}>
          {items.map(i => (
            <span key={i.id} className={styles.conTab} data-on={i.id === current || undefined} data-ended={i.end ? true : undefined}>
              <button type="button" role="tab" aria-selected={i.id === current} onClick={() => setCurrent(i.id)}>{t.name(i.n)}</button>
              <button type="button" className={styles.conX} aria-label={t.closeOne(t.name(i.n))} title={t.closeOne(t.name(i.n))} onClick={() => void close(i.id)}><IconClose size={12} /></button>
            </span>
          ))}
          {items.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void open()} busy={opening} disabled={!usable || live.length >= CONSOLE_MAX}
              title={live.length >= CONSOLE_MAX ? t.max(CONSOLE_MAX) : undefined}>+ {t.add}</Button>
          )}
        </div>
        {shown && !shown.end && (
          <div className={styles.conQuick} role="group" aria-label={t.quick}>
            {QUICK.map(q => (
              <button key={q.key} type="button" className={styles.conChip} title={t.quickTitle(q.cmd)} onClick={() => typers.current.get(shown.id)?.(`${q.cmd}\r`)}>{t.commands[q.key]}</button>
            ))}
          </div>
        )}
      </div>
      {error && <p className={`${styles.bad} ${styles.conNote}`} role="alert">{error}</p>}
      {items.length === 0 && loaded && (
        <div className={styles.conEmpty}>
          <p>{t.lead}</p>
          <p className={styles.muted}>{s === 'paused' ? t.paused : usable ? t.idle(CONSOLE_IDLE_MINUTES) : t.notRunning}</p>
          <Button variant="primary" onClick={() => void open()} busy={opening} disabled={!usable}>{opening ? t.opening : t.open}</Button>
        </div>
      )}
      {items.map(i => (
        <ConsoleTerm key={i.id} taskId={task.id} sid={i.id} label={t.name(i.n)} visible={active && i.id === current}
          onEnd={end => onEnd(i.id, end)} typer={fn => { if (fn) typers.current.set(i.id, fn); else typers.current.delete(i.id); }} />
      ))}
      {shown?.end && (
        <p className={`${styles.muted} ${styles.conNote}`} role="status">
          {shown.end === 'gone' ? t.gone : t.ended[shown.end]}{' '}
          {usable && live.length < CONSOLE_MAX && <button type="button" className={styles.textBtn} onClick={() => { void close(shown.id); void open(); }}>{t.reopen}</button>}
        </p>
      )}
      {items.length > 0 && <p className={`${styles.muted} ${styles.conKeys}`}>{t.keys}</p>}
    </div>
  );
}

/** One session: an xterm.js terminal, its output stream (with reconnect from the last chunk seen) and its input queue. */
function ConsoleTerm({ taskId, sid, label, visible, onEnd, typer }: {
  taskId: string; sid: string; label: string; visible: boolean; onEnd: (end: End) => void; typer: (fn: ((text: string) => void) | null) => void;
}) {
  const t = useT().sandbox.console;
  const box = useRef<HTMLDivElement>(null);
  const refit = useRef<() => void>(() => {});
  const [note, setNote] = useState<string | null>(null);
  const ends = useRef(onEnd);
  useEffect(() => { ends.current = onEnd; });
  const words = useRef(t);
  useEffect(() => { words.current = t; });
  const register = useRef(typer);

  useEffect(() => {
    const ac = new AbortController(), reg = register.current;
    let term: Terminal | null = null, fit: FitAddon | null = null, ro: ResizeObserver | null = null, sizeTimer: ReturnType<typeof setTimeout> | undefined;
    let next = 0, sent = '', sending = false, done = false;
    const queue: string[] = [];
    const flush = async () => {
      if (sending) return;
      sending = true;
      try {
        while (queue.length && !ac.signal.aborted && !done) {
          const all = queue.splice(0).join('');
          for (let i = 0; i < all.length; i += INPUT_PIECE) await api.sandbox.consoleSend(taskId, sid, { input: all.slice(i, i + INPUT_PIECE) }).catch(() => {});
        }
      } finally { sending = false; }
    };
    const type = (text: string) => { queue.push(text); void flush(); };
    const sendSize = () => {
      if (!term || done) return;
      const key = `${term.cols}x${term.rows}`;
      if (key === sent) return;
      sent = key;
      void api.sandbox.consoleSend(taskId, sid, { resize: { cols: term.cols, rows: term.rows } }).catch(() => { sent = ''; });
    };
    refit.current = () => {
      if (!fit || !box.current || box.current.offsetParent === null) return; // hidden: keep the last size
      try { fit.fit(); } catch { return; }
      clearTimeout(sizeTimer); sizeTimer = setTimeout(sendSize, 120);
    };
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (ac.signal.aborted || !box.current) return;
      term = new XTerm({ cursorBlink: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', fontSize: 13, lineHeight: 1.15, scrollback: 5000, theme: THEME, screenReaderMode: false });
      fit = new Fit();
      term.loadAddon(fit);
      term.open(box.current);
      term.textarea?.setAttribute('aria-label', `${words.current.terminal} – ${label}`);
      // copy/paste on Linux and Windows (Ctrl+C stays the interrupt); macOS uses ⌘C/⌘V natively
      term.attachCustomKeyEventHandler(e => {
        if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
        const k = e.key.toLowerCase();
        if (k === 'c' && term?.hasSelection()) { void navigator.clipboard?.writeText(term.getSelection()).catch(() => {}); return false; }
        if (k === 'v') { void navigator.clipboard?.readText().then(x => { if (x) term?.paste(x); }, () => {}); return false; }
        return true;
      });
      term.onData(type);
      reg(text => { type(text); term?.focus(); });
      ro = new ResizeObserver(() => refit.current());
      ro.observe(box.current);
      refit.current();
      let wait = 500;
      while (!ac.signal.aborted) {
        try {
          const r = await listenConsole(taskId, sid, next, ac.signal);
          if (r.status === 404 || r.status === 403) { done = true; ends.current('gone'); return; }
          if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
          setNote(null); wait = 500; sendSize();
          const reader = r.body.getReader();
          const split = createLineSplitter(line => {
            let ev: ConsoleEvent;
            try { ev = JSON.parse(line) as ConsoleEvent; } catch { return; }
            if (ev.t === 'out') { if (ev.seq < next) return; next = ev.seq + 1; term?.write(bytes(ev.data)); return; }
            done = true;
            term?.write(`\r\n\x1b[2m[${words.current.ended[ev.reason]}]\x1b[0m\r\n`);
            ends.current(ev.reason);
          });
          for (;;) { const { done: eof, value } = await reader.read(); if (eof) break; split.push(value); }
          split.end();
          if (done) return;
        } catch { if (ac.signal.aborted) return; }
        setNote(words.current.reconnecting);
        await new Promise(res => setTimeout(res, wait));
        wait = Math.min(5000, wait * 2);
      }
    })();
    return () => { ac.abort(); clearTimeout(sizeTimer); ro?.disconnect(); term?.dispose(); reg(null); };
  }, [taskId, sid, label]);

  // shown again (tab switch, other session): fit to the panel and take the focus
  useEffect(() => { if (visible) requestAnimationFrame(() => refit.current()); }, [visible]);

  return (
    <div className={styles.conTerm} hidden={!visible} data-console={sid}>
      {note && <p className={`${styles.muted} ${styles.conNote}`} role="status">{note}</p>}
      <div ref={box} className={styles.conXterm} />
    </div>
  );
}
