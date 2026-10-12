import 'server-only';
// System-Prompt: statische Regeln liegen versioniert als Markdown in prompts/common (alle Plattformen) und prompts/<plattform>
// (z. B. prompts/shopware: Einkaufswelten, Shopware-Werkzeuge). Kataloge kommen live aus dem Code.
// Reihenfolge: alle Dateien beider Ordner nach Dateinamen sortiert (01-1 … 01-5 greifen ineinander); gleicher Name im
// Plattform-Ordner ersetzt die gemeinsame Datei. Platzhalter {{shop}}, {{platform}} füllt der Adapter (promptVars).
import fs from 'node:fs';
import path from 'node:path';
import type { PlatformKind } from '@/lib/platforms';
import { BLOCKS, blocksFor } from './cms';
import { patternCatalog } from './patterns';
import { activeKind, getPlatform } from './platform';
import { promptBlock } from './styleguide';
import { rulesPromptBlock } from './knowledge';

export const promptRoot = () => path.join(process.cwd(), 'prompts');

/** Markdown-Dateien für eine Plattform in Prompt-Reihenfolge (Pfad je Datei). */
export function promptFiles(kind: PlatformKind, root = promptRoot()): string[] {
  const byName = new Map<string, string>();
  for (const dir of ['common', kind]) {
    const d = path.join(root, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.md')) byName.set(f, path.join(d, f)); // Plattform nach common → ersetzt gleichnamige
  }
  return [...byName.keys()].sort().map(n => byName.get(n)!);
}

/** {{name}} → Wert; unbekannte Platzhalter bleiben stehen (fällt im Test auf) */
export const fillVars = (text: string, vars: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (all, k: string) => vars[k] ?? all);

export function buildBasePrompt(kind: PlatformKind = activeKind(), root = promptRoot()): string {
  const p = getPlatform(kind);
  const parts = promptFiles(kind, root).map(f => fillVars(fs.readFileSync(f, 'utf8').trim(), p.promptVars));
  parts.push(`## Pattern-Katalog (type:"pattern", Felder: pattern + data)\n${patternCatalog()}`);
  parts.push(fillVars(`## Verfügbare Blocktypen\n${blocksFor(p.capabilities.blocks).map(k => `- ${k}: ${BLOCKS[k].desc}`).join('\n')}`, p.promptVars));
  return parts.join('\n\n');
}

// Eigene Regeln der Wissensbasis (gedeckelt); ein Lesefehler darf den Chat nicht blockieren
const shopRules = () => { try { return rulesPromptBlock(); } catch { return ''; } };

/** Vollständiger System-Prompt: Regeln + Kataloge + aktueller Styleguide + eigene Regeln des Shops. */
export const buildSystem = (kind: PlatformKind = activeKind()) => [buildBasePrompt(kind), promptBlock(), shopRules()].filter(Boolean).join('\n\n');
