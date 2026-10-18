import 'server-only';
// "Als GitHub-Projekt anlegen" (A20): a sandbox started without a project gets its repository afterwards. Lotse creates an empty private
// repository with the stored token, pushes the local base (the empty start commit) as its main branch and binds the task to it; from then
// on it is published like any other sandbox ("Zur Prüfung freigeben": the work branch lotse/… with the AI's commits becomes a pull
// request). Only a human click gets here; the AI never creates repositories. A push that failed leaves the new (empty) repository on
// GitHub: the task remembers it, and the next click with the same name fills it instead of failing with "exists".
import { messages, type Locale } from '@/lib/i18n';
import type { CodeTaskPublic } from '@/lib/protocol';
import { auditAdd } from '../db';
import { pushBase } from '../git';
import { checkRepoAccess, createRepo, githubConnected, scrub, type CreateRepoError } from '../github';
import { errMsg } from '../util';
import { TaskConflict, setupBusy } from './jobs';
import { markPublishing, mustTask, publicTask, publishRunning, saveTask, taskPaths, turnRunning } from './tasks';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function createGithubProject(id: string, p: { owner: string; name: string }, locale: Locale): Promise<CodeTaskPublic> {
  const m = messages(locale).server, t = mustTask(id);
  if (t.repo || t.setup?.source !== 'none') throw new TaskConflict(m.repoAlready);
  if (!githubConnected()) throw fail(400, m.repoGithubOff);
  if (publishRunning(id) || setupBusy(id)) throw new TaskConflict(m.publishSetupBusy);
  if (turnRunning(id)) throw new TaskConflict(m.repoTurnRunning);
  if (t.status === 'done') throw new TaskConflict(m.publishTaskDone);
  if (!t.steps.some(s => s.key === 'clone' && s.state === 'done')) throw new TaskConflict(m.repoNotSetUp);
  // an earlier click created this repository but could not fill it (push failed): it is used again instead of failing with "exists"
  const again = t.createdRepo && t.createdRepo.toLowerCase() === `${p.owner}/${p.name}`.toLowerCase() ? t.createdRepo : null;
  return markPublishing(id, (async () => {
    let repo: { fullName: string; private: boolean };
    if (again) repo = { fullName: again, private: true };
    else try { repo = await createRepo({ owner: p.owner, name: p.name, autoInit: false, description: t.title }); } catch (e) {
      const code = (e as { code?: CreateRepoError }).code;
      if (code === 'name') throw fail(400, m.repoNameInvalid);
      if (code === 'owner') throw fail(400, m.repoOwnerUnknown);
      if (code === 'exists') throw fail(409, m.repoExists(`${p.owner}/${p.name}`));
      if (code === 'permission') throw fail(403, m.repoNoPermission(p.owner));
      throw fail(502, m.repoCreateFailed(scrub(errMsg(e))));
    }
    if (!again) {
      const created = mustTask(id);
      created.createdRepo = repo.fullName; // remembered before the push: a retry with the same name reuses it
      saveTask(created, false);
      auditAdd({ decision: 'changed', kind: 'github-repo', action: 'create', title: `GitHub-Projekt angelegt: ${repo.fullName}`, repo: repo.fullName, private: repo.private, taskId: id, ...(t.chatId ? { chatId: t.chatId } : {}) });
    }
    try { await checkRepoAccess(repo.fullName); } catch { throw fail(409, m.repoNotVisible(repo.fullName)); }
    const paths = taskPaths(id);
    try { await pushBase(repo.fullName, t.baseBranch, paths.worktree, paths.gitDir); } catch (e) { throw fail(502, m.repoPushFailed(repo.fullName, scrub(errMsg(e)).slice(0, 300))); }
    const fresh = mustTask(id);
    fresh.repo = repo.fullName; fresh.createdRepo = null;
    saveTask(fresh);
    auditAdd({ decision: 'changed', kind: 'sandbox-task', taskId: id, action: 'github-project', title: `Sandbox-Aufgabe: ${fresh.title}`, repo: repo.fullName, branch: fresh.branch });
    return publicTask(fresh);
  })());
}
