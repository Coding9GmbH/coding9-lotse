import 'server-only';
// Own Dockerfile of the sandbox environment: the admin writes the instructions after FROM (PHP extensions, apt packages …), Lotse puts
// `FROM <the task's Dockware image>` in front and builds a local image from it. The build context holds nothing but the Dockerfile.
import crypto from 'node:crypto';

export const DOCKERFILE_MAX = 8000;
/** Only these instructions: nothing that reaches outside the image (no FROM, COPY/ADD, no BuildKit mounts or heredocs) */
const ALLOWED = new Set(['RUN', 'ENV', 'ARG', 'USER', 'WORKDIR', 'LABEL']);

/** Normalized Dockerfile text ('' = none); throws a German message for an instruction that is not allowed. */
export function checkDockerfile(text: string): string {
  const src = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
  if (src.length > DOCKERFILE_MAX) throw new Error(`Dockerfile: höchstens ${DOCKERFILE_MAX} Zeichen.`);
  // logical lines: a trailing backslash continues the instruction; comments and blank lines in between are skipped
  let cur = '';
  const instructions: string[] = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!cur && (!line || line.startsWith('#'))) continue;
    if (cur && line.startsWith('#')) continue;
    cur += (cur ? ' ' : '') + line.replace(/\\$/, '').trim();
    if (!line.endsWith('\\')) { instructions.push(cur); cur = ''; }
  }
  if (cur) instructions.push(cur);
  for (const ins of instructions) {
    const word = /^[A-Za-z]+/.exec(ins)?.[0].toUpperCase() ?? '';
    if (word === 'FROM') throw new Error('Dockerfile: FROM setzt Lotse selbst (das Dockware-Image der Sandbox) – die Zeile weglassen.');
    if (!ALLOWED.has(word)) throw new Error(`Dockerfile: Anweisung „${ins.slice(0, 40)}“ ist nicht erlaubt (erlaubt: ${[...ALLOWED].join(', ')}).`);
    if (/--mount=|<<-?\s*['"]?\w+/.test(ins)) throw new Error('Dockerfile: --mount und Heredocs sind nicht erlaubt.');
  }
  return src;
}

/** The image a task runs when the environment has a Dockerfile: `lotse-sandbox/<name>-<hash>:<tag of the base image>` (the tag keeps the
 *  Shopware version readable; the hash changes with base image and Dockerfile, so snapshots and the build cache follow). */
export function customImage(base: string, dockerfile: string | undefined): { name: string; dockerfile: string } | null {
  const text = dockerfile?.trim();
  if (!text) return null;
  const i = base.lastIndexOf(':');
  if (i < 0) return null;
  const full = `FROM ${base}\n${text}\n`;
  const hash = crypto.createHash('sha256').update(full).digest('hex').slice(0, 12);
  const repo = base.slice(0, i).split('/').pop()!.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return { name: `lotse-sandbox/${repo}-${hash}:${base.slice(i + 1)}`, dockerfile: full };
}
/** Image names customImage makes (allowed by the container guards next to the template images) */
export const CUSTOM_IMAGE = /^lotse-sandbox\/[a-z0-9-]+-[0-9a-f]{12}:\d+(?:\.\d+){1,3}(?:-[a-z0-9]+)?$/;
