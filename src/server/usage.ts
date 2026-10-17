import 'server-only';
// Cost brake: every AI turn's cost is stored (ai_usage); with a monthly budget (Einstellungen → KI, or LOTSE_AI_BUDGET_USD) new Claude turns
// stop once it is reached, and each turn gets the remaining budget as its limit (Agent SDK maxBudgetUsd). Codex (ChatGPT subscription) has no USD costs.
import { WARN_SHARE, type UsageStatus } from '@/lib/protocol';
import { usageAdd, usageByDay, usageSince } from './db';
import { getSettings } from './settings';

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
  const budget = budgetUsd(), from = monthStart(now), month = usageSince(from), provider = getSettings().ai.provider;
  const used = budget ? month.cost / budget : null;
  return {
    provider, budget, month: { from: from.slice(0, 10), ...round(month) }, today: round(usageSince(dayStart(now))),
    days: usageByDay(new Date(now.getTime() - 29 * 86_400_000).toISOString().slice(0, 10)).map(round),
    used: used == null ? null : Math.round(used * 1000) / 1000, warn: used != null && used >= WARN_SHARE, blocked: used != null && used >= 1,
  };
}
const round = <T extends { cost: number }>(x: T): T => ({ ...x, cost: Math.round(x.cost * 10_000) / 10_000 });

/** Before a Claude turn: blocked (budget used up) or the remaining budget as the turn's limit; without a budget no limit */
export function budgetGate(now = new Date()): { blocked: false; maxUsd?: number } | { blocked: true; spent: number; budget: number } {
  const budget = budgetUsd(); if (!budget) return { blocked: false };
  const spent = usageSince(monthStart(now)).cost;
  return spent >= budget ? { blocked: true, spent, budget } : { blocked: false, maxUsd: Math.round((budget - spent) * 10_000) / 10_000 };
}

/**
 * The Agent SDK reports the cost cumulatively for a resumed session (total_cost_usd includes earlier turns of the same session).
 * Cost of this turn = new total minus the total remembered for the chat; a smaller total (new session, reset) counts as a whole.
 */
export function turnCost(total: number | undefined, previous: number | null | undefined): number | null {
  if (total == null || !Number.isFinite(total)) return null;
  const prev = previous ?? 0;
  return total >= prev ? total - prev : total;
}

/** Store a finished turn; cost null = unknown (Codex) */
export function recordTurn(u: { chatId: string; provider: string; model?: string; cost: number | null; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }) {
  try { usageAdd({ chatId: u.chatId, provider: u.provider, model: u.model ?? null, costUsd: u.cost, ...u.usage }); } catch { /* the log must never break a turn */ }
}
