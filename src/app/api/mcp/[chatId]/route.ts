import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { mcpTokenValid } from '@/server/codex';
import { getSession } from '@/server/sessions';
import { buildTools } from '@/server/tools';

export const dynamic = 'force-dynamic';

// MCP-Endpunkt (Streamable HTTP, zustandslos) für Codex: dieselben Shop-Tools wie bei Claude.
// Zugriff nur mit dem zufälligen Token, das Lotse dem Codex-Prozess dieses Chats mitgibt.
async function handle(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  if (!mcpTokenValid(chatId, req.headers.get('authorization'))) return new Response('Nicht erlaubt', { status: 401 });
  const server = new McpServer({ name: 'shop', version: '1.0.0' });
  for (const t of buildTools(getSession(chatId)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zod-Schemas sind je Tool verschieden; Prüfung übernimmt das MCP-SDK
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema as any }, (args: any) => t.handler(args, {}) as any);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as GET, handle as POST, handle as DELETE };
