import 'server-only';
// start_sandbox: in a normal chat (Sandbox Coding on) the AI may PROPOSE a sandbox for code work on a plugin or theme.
// It only shows a card with repository and branch preselected; nothing starts until the user clicks it (POST /api/sandbox/tasks).
import crypto from 'node:crypto';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEvent } from '@/lib/protocol';
import { assertRepoName } from '../github';
import { fail, guard, ok, type AnyTool } from '../tool-kit';
import { sandboxPublic } from './env';

export const START_SANDBOX = 'start_sandbox';

export function startSandboxTool(host: { emit: (ev: ChatEvent) => void }): AnyTool {
  return tool(START_SANDBOX, 'Schlägt vor, an diesen Chat eine Sandbox anzuhängen: ein eigener Test-Shopware mit dem Plugin-/Theme-Repository, in dem du Code änderst, Befehle ausführst und das Ergebnis in der Vorschau zeigst (danach Pull Request). Zeigt dem Nutzer nur eine Karte – erst sein Klick legt die Sandbox an. Nur für Änderungen am Code eines Plugins/Themes (Templates, SCSS, PHP), nicht für Inhalte im Live-Shop. In einem Chat mit Sandbox gibt es keine Shop-Werkzeuge mehr.',
    {
      repo: z.string().max(200).optional().describe('GitHub-Repository besitzer/name; leer = Vorgabe der Umgebung'),
      base_branch: z.string().max(200).optional().describe('Basis-Branch; leer = Vorgabe der Umgebung bzw. Standard-Branch'),
      reason: z.string().min(1).max(500).describe('Ein Satz: was in der Sandbox geändert werden soll'),
    },
    guard(async ({ repo, base_branch, reason }) => {
      const env = sandboxPublic();
      const r = (repo ?? '').trim() || env.defaultRepo;
      if (r) { try { assertRepoName(r); } catch (e) { return fail((e as Error).message); } }
      const branch = (base_branch ?? '').trim().slice(0, 200) || (r === env.defaultRepo ? env.defaultBranch : '');
      host.emit({ t: 'sandbox_offer', id: `sbo_${crypto.randomBytes(6).toString('hex')}`, repo: r, baseBranch: branch, reason: reason.trim() });
      return ok('Karte angezeigt. Erst wenn der Nutzer sie bestätigt, wird die Sandbox eingerichtet; ab der nächsten Nachricht arbeitest du dann in diesem Chat in der Sandbox. Bis dahin nichts weiter tun.');
    })) as AnyTool;
}
