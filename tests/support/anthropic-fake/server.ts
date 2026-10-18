/**
 * Local stand-in for the Anthropic Messages API (E2E tests only). The real Claude Code process of the Agent SDK
 * talks to this server via ANTHROPIC_BASE_URL; the "model" follows a fixed script instead of thinking.
 *
 *   npx tsx tests/support/anthropic-fake/server.ts --port 3602
 *
 * Script (controlled via the last user message):
 *  - if it contains `[e2e:propose <product-id> <field>=<value>]`, the model calls `propose_product_changes`
 *    and, after the tool result, replies with "Erledigt: <status>"
 *  - chats with a sandbox (Sandbox Coding), with Claude Code's own file tools in the worktree (its path is read from the system prompt,
 *    line "Arbeitsverzeichnis (Repository-Wurzel): …"): `[e2e:replace <path> <old>|<new>]` = Read, then Edit; `[e2e:write <path> <text>]`
 *    = Write (a .html.twig becomes a template that extends Shopware's and puts <text> into the outer block); `[e2e:bash <command line>]`
 *    = sandbox_bash; `[e2e:commit <message>]` = git_commit (all changes); `[e2e:pr <title>|<description>]` = propose_publish (the card for the pull request). Several markers run in order, one tool call per model request, then it replies "Fertig: <n> Schritte."
 *  - otherwise it replies with a short text ("Hallo aus dem Test-Modell.")
 *
 * Control endpoints: GET /__fake/requests (received requests: last message as JSON, truncated, and the text of the user messages, the end of it), POST /__fake/reset, GET /__fake/health.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

type Block = { type: string; text?: string; content?: unknown; tool_use_id?: string; name?: string; input?: unknown; id?: string };
interface Msg { role: string; content: string | Block[] }
interface MessagesBody { model?: string; system?: string | { type: string; text?: string }[]; messages?: Msg[]; tools?: { name: string }[]; stream?: boolean }

export const GREETING = 'Hallo aus dem Test-Modell.';
const PROPOSE = /\[e2e:propose (\S+) (\w+)=([^\]]+)\]/;
const CODE_STEP = /\[e2e:(replace|write|bash|commit|pr) ([^\]]+)\]/g;
const WORKDIR = /Arbeitsverzeichnis \(Repository-Wurzel\): (\S+)/;
/** Outer block of a few Shopware storefront templates (the scripted edit extends it) */
const BLOCKS: Record<string, string> = { 'header.html.twig': 'layout_header', 'footer.html.twig': 'layout_footer' };

/** Content of a scripted edit: a Twig template extending Shopware's with the text in front of the original block, other files = the text. */
export function scriptedFile(path: string, text: string): string {
  const m = /Resources\/views\/(storefront\/.+\.html\.twig)$/.exec(path);
  if (!m) return `${text}\n`;
  const block = BLOCKS[m[1].split('/').pop() ?? ''] ?? 'base_body';
  return `{% sw_extends '@Storefront/${m[1]}' %}\n\n{% block ${block} %}\n    <div class="lotse-e2e-note">${text}</div>\n    {{ parent() }}\n{% endblock %}\n`;
}

/** The calls of the code markers in order: replace = Read + Edit (Claude Code edits only files it has read). */
function codeCalls(text: string, root: string): { name: string; input: unknown }[] {
  const abs = (p: string) => `${root}/${p}`;
  return [...text.matchAll(CODE_STEP)].flatMap(([, kind, rest]): { name: string; input: unknown }[] => {
    if (kind === 'bash') return [{ name: 'sandbox_bash', input: { command: rest.trim() } }];
    if (kind === 'commit') return [{ name: 'git_commit', input: { message: rest.trim() } }];
    if (kind === 'pr') { const [title, body = ''] = rest.split('|'); return [{ name: 'propose_publish', input: { title: title.trim(), body: body.trim() } }]; }
    const [p, ...more] = rest.trim().split(' '), arg = more.join(' ');
    if (kind === 'write') return [{ name: 'Write', input: { file_path: abs(p), content: scriptedFile(p, arg || 'Lotse') } }];
    const [oldText, newText] = arg.split('|');
    return [{ name: 'Read', input: { file_path: abs(p) } }, { name: 'Edit', input: { file_path: abs(p), old_string: oldText, new_string: newText ?? '' } }];
  });
}

/** Code script: the markers of the last user text, one tool call per request (tool calls since that message = steps done). */
function codeTurn(msgs: Msg[], tools: { name: string }[], system: string): { text?: string; tool?: { name: string; input: unknown } } | null {
  const start = msgs.findLastIndex(m => m.role === 'user' && !blocks(m).some(b => b.type === 'tool_result')); // the user's last message
  if (start < 0 || !/\[e2e:(replace|write|bash|commit|pr) /.test(textOf(msgs[start]))) return null;
  const root = WORKDIR.exec(system)?.[1];
  if (!root) return { text: 'Arbeitsverzeichnis fehlt im Systemprompt.' };
  const calls = codeCalls(textOf(msgs[start]), root);
  const done = msgs.slice(start + 1).filter(m => m.role === 'assistant').flatMap(blocks).filter(b => b.type === 'tool_use').length;
  const step = calls[done];
  if (!step) return { text: `Fertig: ${calls.length} Schritte.` };
  const name = tools.find(t => t.name === step.name || t.name.endsWith(`__${step.name}`))?.name;
  if (!name) return { text: `Werkzeug ${step.name} fehlt.` };
  return { tool: { name, input: step.input } };
}

const blocks = (m: Msg): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content);
const textOf = (m: Msg) => blocks(m).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
const resultText = (b: Block) => (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(c => (c as Block).text ?? '').join('') : '');

/** Next move of the script: text or tool call. */
export function nextTurn(body: MessagesBody): { text?: string; tool?: { name: string; input: unknown } } {
  // Only user/assistant messages count (the CLI appends further roles depending on the environment)
  const msgs = (body.messages ?? []).filter(m => m.role === 'user' || m.role === 'assistant');
  const last = msgs.at(-1);
  if (!last) return { text: GREETING };
  const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map(b => b.text ?? '').join('\n');
  const code = codeTurn(msgs, body.tools ?? [], system);
  if (code) return code;
  const toolResult = blocks(last).find(b => b.type === 'tool_result');
  if (toolResult) {
    const status = resultText(toolResult).match(/"status"\s*:\s*"(\w+)"/)?.[1] ?? 'unbekannt';
    return { text: `Erledigt: ${status}` };
  }
  const m = textOf(last).match(PROPOSE);
  const tool = body.tools?.find(t => t.name.endsWith('propose_product_changes'));
  if (m && tool) {
    const [, id, field, value] = m;
    return { tool: { name: tool.name, input: { title: `E2E: ${field} ändern`, reason: 'Test-Drehbuch', changes: [{ id, fields: { [field]: value } }] } } };
  }
  return { text: GREETING };
}

let seq = 0;
const sse = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function reply(res: ServerResponse, body: MessagesBody) {
  const turn = nextTurn(body), id = `msg_fake_${++seq}`, model = body.model ?? 'claude-fake';
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const toolId = `toolu_fake_${seq}`;
  const content = turn.tool
    ? [{ type: 'tool_use', id: toolId, name: turn.tool.name, input: turn.tool.input }]
    : [{ type: 'text', text: turn.text ?? '' }];
  const stop_reason = turn.tool ? 'tool_use' : 'end_turn';
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': id });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content, stop_reason, stop_sequence: null, usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': id });
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  if (turn.tool) {
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: turn.tool.name, input: {} } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.tool.input) } });
  } else {
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text ?? '' } });
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

const readBody = (req: IncomingMessage) => new Promise<string>((ok, fail) => { let s = ''; req.setEncoding('utf8'); req.on('data', c => { s += c; }); req.on('end', () => ok(s)); req.on('error', fail); });

export interface FakeAnthropic { url: string; port: number; requests: { path: string; tools: string[]; last: string; text: string }[]; close(): Promise<void> }

export async function startFakeAnthropic(opts: { port?: number; host?: string; quiet?: boolean } = {}): Promise<FakeAnthropic> {
  const requests: FakeAnthropic['requests'] = [];
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (path === '/__fake/health') { res.end('ok'); return; }
      if (path === '/__fake/requests') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(requests)); return; }
      if (path === '/__fake/reset') { requests.length = 0; res.end('ok'); return; }
      const raw = req.method === 'POST' ? await readBody(req) : '';
      if (path === '/v1/messages/count_tokens') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ input_tokens: 10 })); return; }
      if (path === '/v1/messages' && req.method === 'POST') {
        const body = JSON.parse(raw) as MessagesBody;
        const last = body.messages?.at(-1);
        requests.push({ path, tools: (body.tools ?? []).map(t => t.name), last: last ? JSON.stringify(last.content).slice(0, 300) : '', text: (body.messages ?? []).filter(m => m.role === 'user').map(textOf).join('\n').slice(-8000) });
        if (!opts.quiet) console.log(`[anthropic-fake] ${path} tools=${(body.tools ?? []).map(t => t.name).join(",")} last=${JSON.stringify(last?.content ?? "").slice(0, 200)} → ${JSON.stringify(nextTurn(body)).slice(0, 120)}`);
        reply(res, body);
        return;
      }
      // Everything else (telemetry, account queries): quietly answer with empty JSON
      res.setHeader('content-type', 'application/json'); res.end('{}');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e instanceof Error ? e.message : String(e) } }));
    }
  });
  await new Promise<void>(ok => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, requests, close: () => new Promise(ok => server.close(() => ok())) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const fake = await startFakeAnthropic({ port: Number(arg('port') ?? 3602), host: arg('host'), quiet: process.argv.includes('--quiet') });
  console.log(`Anthropic-Fake läuft auf ${fake.url}`);
}
