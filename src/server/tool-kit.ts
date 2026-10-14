import 'server-only';
// Shared building blocks for AI tools (tools.ts and feature modules under features/).
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { redact } from './settings';

export interface ToolResult { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean; [k: string]: unknown }
export const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
export const fail = (msg: unknown): ToolResult => ({ content: [{ type: 'text', text: `FEHLER: ${redact(msg)}` }], isError: true });
export const guard = <A>(fn: (a: A) => Promise<ToolResult>) => async (a: A): Promise<ToolResult> => { try { return await fn(a); } catch (e) { return fail(e instanceof Error ? e.message : e); } };
/** Paginated reading: Shopware only knows page + limit. An offset that isn't a multiple of limit is rounded down to the page;
 *  responses report the offset actually read (plus note), so the AI never counts rows twice or skips them. */
export function pageOf(offset: number | undefined, limit: number): { limit: number; page: number; offset: number; note?: string } {
  const want = Math.max(0, Math.floor(offset ?? 0)), page = Math.floor(want / limit) + 1, eff = (page - 1) * limit;
  return { limit, page, offset: eff, ...(eff !== want ? { note: `offset auf ${eff} gerundet (Vielfaches von limit=${limit})` } : {}) };
}
/** nextOffset, if more records remain after the page read */
export const nextOffsetOf = (offset: number, returned: number, limit: number, total: number | undefined) => (offset + returned < (total ?? 0) ? offset + limit : null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = SdkMcpToolDefinition<any>;
