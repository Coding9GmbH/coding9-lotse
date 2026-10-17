'use client';

import { useEffect, useState } from 'react';
import { errorText, listenTask } from '@/lib/api';
import { createLineSplitter } from '@/lib/ndjson';
import type { CodeTaskPublic, TaskEvent } from '@/lib/protocol';
import { applyTaskEvent } from '@/lib/sandbox-task';

/** One code task, live: snapshot then events (NDJSON). Reconnects after a dropped stream; an open view keeps the container awake. */
export function useTaskEvents(id: string) {
  const [task, setTask] = useState<CodeTaskPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    let wait = 1000;
    const connect = async () => {
      while (!ac.signal.aborted) {
        try {
          const r = await listenTask(id, ac.signal);
          if (r.status === 404) { setGone(true); return; }
          if (!r.ok || !r.body) {
            const body = await r.json().catch(() => null) as { error?: string } | null;
            throw new Error(body?.error ?? `HTTP ${r.status}`);
          }
          setError(null); wait = 1000;
          const reader = r.body.getReader();
          const split = createLineSplitter(line => {
            let ev: TaskEvent;
            try { ev = JSON.parse(line) as TaskEvent; } catch { return; }
            if (ev.t === 'deleted') setGone(true);
            setTask(t => applyTaskEvent(t, ev));
          });
          for (;;) { const { done, value } = await reader.read(); if (done) break; split.push(value); }
          split.end();
        } catch (e) {
          if (ac.signal.aborted) return;
          setError(errorText(e));
        }
        await new Promise(r => setTimeout(r, wait));
        wait = Math.min(10_000, wait * 2);
      }
    };
    void connect();
    return () => ac.abort();
  }, [id]);

  return { task, setTask, error, gone };
}
