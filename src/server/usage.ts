import 'server-only';
// Cost brake: every AI turn's cost is stored (ai_usage); with a monthly budget (Einstellungen → KI, or LOTSE_AI_BUDGET_USD) new Claude turns
// stop once it is reached, and each turn gets the remaining budget as its limit (Agent SDK maxBudgetUsd). Codex (ChatGPT subscription) has no USD costs.
import { WARN_SHARE, type UsageStatus } from '@/lib/protocol';
import { usageAdd, usageByDay, usageSince } from './db';
import { getSettings } from './settings';
import { singleton } from './state';

/** Budget in USD from the setting ("50", "49,90"); empty, invalid or 0 = no limit */
export function parseBudget(v: string | undefined | null): number | null {
  const n = Number(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
export const budgetUsd = () => parseBudget(getSettings().ai.budget);

/** First moment of the calendar month (UTC) */
export const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
const dayStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

export function usageStatus(now = new Date()): UsageStatus {
  // only Claude has costs per turn: Codex turns (subscription) would only inflate the number of turns
  const budget = budgetUsd(), from = monthStart(now), month = usageSince(from, 'claude'), provider = getSettings().ai.provider;
  const used = budget ? month.cost / budget : null;
  return {
    provider, budget, month: { from: from.slice(0, 10), ...round(month) }, today: round(usageSince(dayStart(now), 'claude')),
    days: usageByDay(new Date(now.getTime() - 29 * 86_400_000).toISOString().slice(0, 10)).map(round),
    used: used == null ? null : Math.round(used * 1000) / 1000, warn: used != null && used >= WARN_SHARE, blocked: used != null && used >= 1,
  };
}
const round = <T extends { cost: number }>(x: T): T => ({ ...x, cost: Math.round(x.cost * 10_000) / 10_000 });

// Budget reserved by turns that are running right now (per chat): parallel chats share the remaining budget instead of each getting all of it
const reserved = () => singleton('usage-reserved', () => new Map<string, number>());
export const releaseBudget = (chatId: string) => { reserved().delete(chatId); };

/** Cost brake for the status line (health): only the monthly sum, without the day series */
export function budgetBrief(now = new Date()): { spent: number; limit: number; warn: boolean; blocked: boolean } | null {
  const budget = budgetUsd(); if (!budget || getSettings().ai.provider !== 'claude') return null;
  const spent = Math.round(usageSince(monthStart(now), 'claude').cost * 10_000) / 10_000;
  return { spent, limit: budget, warn: spent / budget >= WARN_SHARE, blocked: spent >= budget };
}

/**
 * Before a Claude turn: blocked (budget used up) or the turn's limit: half of the budget not yet spent or reserved by running turns,
 * reserved for this chat until releaseBudget. So parallel chats can never exceed the budget together, and none is locked out.
 * Without a budget no limit.
 */
export const MIN_TURN_USD = 0.01;
export function budgetGate(now = new Date(), chatId?: string): { blocked: false; maxUsd?: number } | { blocked: true; spent: number; budget: number } {
  const budget = budgetUsd(); if (!budget) return { blocked: false };
  const spent = usageSince(monthStart(now)).cost, held = [...reserved().values()].reduce((n, x) => n + x, 0);
  if (spent >= budget) return { blocked: true, spent, budget };
  const free = budget - spent - held;
  if (free < MIN_TURN_USD) return { blocked: true, spent: Math.min(budget, spent + held), budget };
  const maxUsd = Math.max(MIN_TURN_USD, Math.floor((free / 2) * 10_000) / 10_000);
  if (chatId) reserved().set(chatId, maxUsd);
  return { blocked: false, maxUsd };
}

/**
 * The Agent SDK reports the cost cumulatively for a resumed session (total_cost_usd includes earlier turns of the same session).
 * Cost of this turn = new total minus the total remembered for the chat's session. A new SDK session or a smaller total (reset)
 * counts as a whole. Crash/startup error results may report 0: then the remembered total stays (otherwise the next turn would
 * count the earlier turns again). Without a reported cost (aborted turn) nothing is counted; the next turn of the chat includes it.
 */
export interface CostState { total: number | null; session: string | null }
export function turnCost(end: { cost?: number; error?: string | null }, prev: CostState, session: string | null): { cost: number | null; next: CostState } {
  const total = end.cost;
  if (total == null || !Number.isFinite(total) || (total === 0 && end.error)) return { cost: null, next: prev };
  const same = prev.session != null && prev.session === session, before = same ? prev.total ?? 0 : 0;
  return { cost: total >= before ? total - before : total, next: { total, session } };
}

/** Store a finished turn; cost null = unknown (Codex) */
export function recordTurn(u: { chatId: string; provider: string; model?: string; cost: number | null; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }) {
  try { usageAdd({ chatId: u.chatId, provider: u.provider, model: u.model ?? null, costUsd: u.cost, ...u.usage }); } catch { /* the log must never break a turn */ }
}
