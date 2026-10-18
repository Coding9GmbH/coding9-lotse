import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import '../isolate-data';
import type { ChatEvent, TaskDiff } from '@/lib/protocol';
import { GITHUB_TOKEN, sandboxForTests } from '../support/sandbox-task';
/* eslint-disable @typescript-eslint/no-explicit-any -- tool handlers take loose input */

// git_commit (A14): the AI commits locally in the task's worktree like Claude Code does – all changes or given paths, with its own
// message, author Lotse and the chat's user as co-author. Only through the hardened git.ts: no push, no branch switch, no history
// rewrite, a length limit on the message, the same path/workflow/secret rules as publishing (nothing overridable). The "Änderungen"
// tab lists the commits and what is not committed yet; publishing pushes the commits as they are and adds a last commit only for
// what is still uncommitted.
const SECRET = 'mein-sandbox-passwort-2024';
const S = await sandboxForTests({ env: [{ key: 'SHOP_PASSWORD', value: SECRET, secret: true }] });
const { theme, T } = S;
const W = await import('../../src/server/sandbox/workspace-tools');
const P = await import('../../src/server/sandbox/publish');
const G = await import('../../src/server/git');
const { withActor, noteChatActor } = await import('../../src/server/actor');
const diffRoute = await import('../../src/app/api/sandbox/tasks/[id]/diff/route');
after(S.close);

const task = await S.readyTask('Versandhinweis');
noteChatActor(task.chatId!, 'alex');
const events: ChatEvent[] = [];
const host = { id: task.chatId!, taskId: task.id, emit: (ev: ChatEvent) => { events.push(ev); }, askUser: async () => 'Ja', approvals: new Map(), abort: null };
const tools = W.sandboxTools(host);
const call = async (name: string, input: Record<string, unknown> = {}) => {
  const r = await tools.find(t => t.name === name)!.handler(input as any, {});
  return { error: !!r.isError, text: r.content.map((c: any) => c.text ?? '').join('') };
};
const commit = (message: string, paths?: string[]) => call('git_commit', { message, ...(paths ? { paths } : {}) });
const wt = T.taskPaths(task.id).worktree, gd = T.taskPaths(task.id).gitDir;
const write = (rel: string, text: string) => { const f = path.join(wt, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const remove = (rel: string) => fs.rmSync(path.join(wt, rel), { recursive: true, force: true });
const git = (...args: string[]) => execFileSync('git', [`--git-dir=${gd}`, `--work-tree=${wt}`, ...args], { encoding: 'utf8', cwd: wt }).trim();
const bare = (...args: string[]) => execFileSync('git', ['--git-dir', theme.bare, ...args], { encoding: 'utf8' }).trim();
const remoteRefs = () => bare('for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort();
const diff = async () => (await (await diffRoute.GET(new Request(`http://127.0.0.1/api/sandbox/tasks/${task.id}/diff`), { params: Promise.resolve({ id: task.id }) })).json()) as TaskDiff;
const HEADER = 'src/Resources/views/storefront/layout/header/header.html.twig';
const SNIPPET = 'src/Resources/snippet/de_DE/versand.de-DE.json';
const base = git('rev-parse', 'HEAD'), branchBefore = git('symbolic-ref', '--short', 'HEAD'), refsBefore = remoteRefs();

test('the tool is offered to Claude and Codex; nothing to commit is no error', async () => {
  assert.ok(W.sandboxToolNames('claude').includes('git_commit') && W.sandboxToolNames('codex').includes('git_commit'));
  const r = await commit('Nichts');
  assert.equal(r.error, false);
  assert.match(r.text, /nichts committet/);
  assert.equal(git('rev-parse', 'HEAD'), base);
});

test('commit all: one local commit on top of HEAD, author Lotse, the chat user as co-author; nothing pushed, no branch switch', async () => {
  write(HEADER, "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div>Gratis Versand</div>{{ parent() }}{% endblock %}\n");
  const r = await commit('Versandhinweis im Header anzeigen\n\nKunden sehen sofort, ab wann der Versand gratis ist.');
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /^Commit [0-9a-f]{7} \(1 Datei\): Versandhinweis im Header anzeigen\. Nur lokal gespeichert/);
  assert.equal(git('rev-parse', 'HEAD~1'), base, 'a child of the previous HEAD');
  assert.equal(git('log', '-1', '--format=%an <%ae>|%cn'), 'Lotse <lotse@users.noreply.github.com>|Lotse');
  assert.equal(git('log', '-1', '--format=%B'), 'Versandhinweis im Header anzeigen\n\nKunden sehen sofort, ab wann der Versand gratis ist.\n\nCo-Authored-By: alex <alex@lotse.invalid>');
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), branchBefore, 'still on the cloned branch');
  assert.deepEqual(remoteRefs(), refsBefore, 'nothing pushed');
  assert.equal(git('status', '--porcelain'), '');
});

test('commit given paths only: the rest stays uncommitted; the "Änderungen" data lists commits and uncommitted files', async () => {
  write(SNIPPET, '{ "versand": "Gratis Versand ab 50 €" }\n');
  write('README.md', '# Acme Theme\n\nMit Versandhinweis.\n');
  const r = await commit('Text für den Versandhinweis ergänzen', [SNIPPET]);
  assert.equal(r.error, false, r.text);
  assert.equal(git('show', '--name-only', '--format=', 'HEAD'), SNIPPET);
  assert.equal(git('status', '--porcelain'), 'M README.md');
  const d = await diff();
  assert.deepEqual(d.commits!.map(c => [c.subject, c.published]), [['Text für den Versandhinweis ergänzen', false], ['Versandhinweis im Header anzeigen', false]]);
  assert.deepEqual(d.uncommitted, ['README.md']);
  assert.deepEqual(d.files.map(f => f.path).sort(), ['README.md', HEADER, SNIPPET].sort(), 'the net diff against the base covers commits and uncommitted changes');
  const gd2 = await call('git_diff');
  assert.match(gd2.text, /Lokale Commits \(neueste zuerst\):\n[0-9a-f]{7} Text für den Versandhinweis ergänzen\n[0-9a-f]{7} Versandhinweis im Header anzeigen/);
  assert.match(gd2.text, /Noch nicht committet: README\.md/);
});

test('safety: message limits, path tricks, .git, protected files, workflows and secrets are refused; HEAD stays', async () => {
  const head = git('rev-parse', 'HEAD');
  const refused = async (message: string, paths: string[] | undefined, why: RegExp) => {
    const r = await commit(message, paths);
    assert.equal(r.error, true, `${message} ${paths ?? ''}: ${r.text}`);
    assert.match(r.text, why);
    assert.equal(git('rev-parse', 'HEAD'), head, 'nothing committed');
  };
  await refused('x'.repeat(G.COMMIT_LIMITS.subject + 1), undefined, /erste Zeile .* zu lang/);
  await refused('\x00\x07  ', undefined, /Commit-Nachricht fehlt/);
  for (const p of ['../outside.txt', 'a/../../x', '.git', '.git/config', '-n', '/etc/passwd', 'src\\x', '~/x']) await refused('Pfad', [p], /Ungültiger Pfad|Pfade mit „~“|außerhalb des Repositorys/);
  const none = await commit('Fremd', ['src/gibt-es-nicht.txt']);
  assert.equal(none.error, false);
  assert.match(none.text, /Keine Änderungen an src\/gibt-es-nicht\.txt – nichts committet/);
  await refused('Gemischt', ['README.md', 'src/gibt-es-nicht.txt'], /Keine Änderungen an: src\/gibt-es-nicht\.txt/);

  const envBefore = fs.readFileSync(path.join(wt, '.env'), 'utf8'); // the test repository tracks a .env (never synced, never published)
  write('.env', 'APP_SECRET=xyz\n');
  await refused('Alles', undefined, /geschützte Datei[\s\S]*Mit paths nur die übrigen Dateien committen/);
  await refused('Env', ['.env'], /geschützte Datei/);
  write('.env', envBefore);
  write('.github/workflows/deploy.yml', 'on: push\n');
  await refused('Workflow', undefined, /GitHub-Workflows/);
  remove('.github');
  write('src/Resources/config/token.txt', `${GITHUB_TOKEN}\n`);
  const tok = await commit('Token');
  assert.equal(tok.error, true);
  assert.match(tok.text, /Nicht committet: In „src\/Resources\/config\/token\.txt“ \(Zeile 1\) .*GitHub-Token/);
  assert.ok(!tok.text.includes(GITHUB_TOKEN), 'never the value');
  remove('src/Resources/config/token.txt');
  // a stored secret could be a false positive at publishing – but never in a commit (history is never rewritten)
  write('src/Resources/config/shop.php', `<?php return ['pw' => '${SECRET}'];\n`);
  await refused('Passwort', ['src/Resources/config/shop.php'], /gespeichertes Geheimnis[\s\S]*der Nutzer entscheidet beim Veröffentlichen/);
  remove('src/Resources/config/shop.php');
  assert.equal(git('status', '--porcelain'), 'M README.md', 'only the earlier uncommitted change is left');
});

test('git.ts itself: messages cleaned and capped, literal pathspecs (a "*" is a file name, not a glob)', async () => {
  assert.equal(G.commitMessage('  Titel\r\n\r\n\r\n\r\nText\x1b[31m  '), 'Titel\n\nText[31m');
  assert.throws(() => G.commitMessage(`T\n${'x'.repeat(G.COMMIT_LIMITS.message)}`), /zu lang/);
  assert.equal(G.assertCommitPath('./src/x/'), 'src/x');
  write('src/a.txt', 'a\n');
  write('src/b.txt', 'b\n');
  const head = git('rev-parse', 'HEAD');
  assert.equal(await G.commitChanges(wt, gd, 'Glob', P.LOTSE_AUTHOR, undefined, ['src/*.txt']), null, 'no file is called "*.txt"');
  assert.equal(git('rev-parse', 'HEAD'), head);
  remove('src/a.txt'); remove('src/b.txt');
});

test('publish with existing commits: pushed as they are, a last commit only for what is uncommitted; then all published', async () => {
  const local = git('rev-list', '--count', `${base}..HEAD`);
  assert.equal(local, '2');
  const r = await withActor('alex', () => P.publishTask(task.id, { title: 'Versandhinweis', body: 'Geprüft in der Vorschau.' }));
  assert.equal(r.action, 'created');
  const pushed = bare('log', '--format=%s', `${base}..${task.branch}`).split('\n');
  assert.deepEqual(pushed, ['Versandhinweis', 'Text für den Versandhinweis ergänzen', 'Versandhinweis im Header anzeigen'], 'the AI\'s commits plus one for README.md');
  assert.equal(bare('show', '--name-only', '--format=', task.branch), 'README.md', 'the last commit holds only the uncommitted change');
  const d = await diff();
  assert.ok(d.commits!.every(c => c.published), JSON.stringify(d.commits));
  assert.deepEqual(d.uncommitted, []);
  assert.equal(d.unpublished, false);

  // the AI commits again: only that commit is pushed, no extra commit when nothing is uncommitted
  write(HEADER, "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div>Gratis Versand ab 50 €</div>{{ parent() }}{% endblock %}\n");
  assert.equal((await commit('Schwelle für den Gratis-Versand nennen')).error, false);
  const d2 = await diff();
  assert.deepEqual(d2.commits!.map(c => c.published), [false, true, true, true]);
  assert.equal(d2.unpublished, true);
  const before = bare('rev-parse', task.branch);
  await withActor('alex', () => P.publishTask(task.id, { title: 'Versandhinweis', body: 'Geprüft.' }));
  assert.equal(bare('rev-parse', `${task.branch}~1`), before, 'a fast-forward');
  assert.equal(bare('log', '-1', '--format=%s', task.branch), 'Schwelle für den Gratis-Versand nennen', 'no extra commit');
  assert.deepEqual(remoteRefs(), [...refsBefore, `refs/heads/${task.branch}`].sort());
});
