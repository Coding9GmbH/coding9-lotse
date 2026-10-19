import 'server-only';
// Makes the image of a sandbox available: the Dockware image is pulled, with an own Dockerfile in the environment the image built on top
// of it is built once (named by base image and Dockerfile, so a change builds a new one and an unchanged one is reused).
import { customImage } from './custom-image';
import type { PullProgress, SandboxRunner } from './runner';

/** The image to run for `base` (+ the environment's Dockerfile), present afterwards. pulled = something was downloaded or built now. */
export async function ensureSandboxImage(runner: SandboxRunner, base: string, dockerfile: string | undefined, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<{ image: string; pulled: boolean; built: boolean }> {
  const custom = customImage(base, dockerfile);
  if (!custom) return { image: base, ...(await runner.ensureImage(base, onProgress, signal)), built: false };
  if (await runner.imagePresent(custom.name)) return { image: custom.name, pulled: false, built: false };
  const { pulled } = await runner.ensureImage(base, onProgress, signal);
  onProgress({ text: 'Eigenes Image wird gebaut (Dockerfile der Umgebung) …' });
  await runner.buildImage(custom.name, custom.dockerfile, onProgress, signal);
  return { image: custom.name, pulled, built: true };
}
