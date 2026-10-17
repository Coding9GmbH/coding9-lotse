import 'server-only';
// Guards shared by both runner implementations: labels, ids, paths, image and container spec.
import { TEMPLATES } from './templates';
import type { ContainerSpec } from './runner';

export const MANAGED_LABEL = 'lotse.managed';
export const TASK_LABEL = 'lotse.task';
export const MANAGED = { [MANAGED_LABEL]: '1' } as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export function assertId(id: string): string {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Ungültige Container-ID.');
  return id;
}
/** Only an image that one of the registered templates allows (pinned dockware/play). */
export function assertAllowedImage(image: string): string {
  if (!Object.values(TEMPLATES).some(t => t.imagePattern.test(image))) throw new Error(`Image „${image}“ ist nicht erlaubt (nur dockware/play mit fester Version).`);
  return image;
}
export const isManaged = (labels: Record<string, string> | null | undefined) => labels?.[MANAGED_LABEL] === '1';
export function assertManaged<T extends { labels: Record<string, string> } | null>(c: T): NonNullable<T> {
  if (!c) throw new Error('Container nicht gefunden.');
  if (!isManaged(c.labels)) throw new Error('Container wird nicht von Lotse verwaltet: Zugriff verweigert.');
  return c as NonNullable<T>;
}
const FORBIDDEN_HOST = ['Privileged', 'Binds', 'Devices', 'Mounts', 'CapAdd', 'VolumesFrom', 'DeviceRequests', 'DeviceCgroupRules'];
/** Second line of defence behind the template's spec builder: no host access in any form. */
export function assertSafeSpec(spec: ContainerSpec): ContainerSpec {
  if (!/^lotse-[a-z0-9-]{1,60}$/.test(spec.name)) throw new Error('Ungültiger Container-Name.');
  if (!isManaged(spec.Labels)) throw new Error('Container ohne Lotse-Label werden nicht angelegt.');
  assertAllowedImage(spec.Image);
  const h = spec.HostConfig ?? {};
  for (const k of FORBIDDEN_HOST) {
    const v = h[k];
    if (v === true || (Array.isArray(v) && v.length) || (v && typeof v === 'object' && !Array.isArray(v))) throw new Error(`Container-Spezifikation abgelehnt: ${k} ist nicht erlaubt.`);
  }
  for (const k of ['NetworkMode', 'PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode']) if (h[k] === 'host') throw new Error(`Container-Spezifikation abgelehnt: ${k}=host ist nicht erlaubt.`);
  return spec;
}
/** Absolute container path without "..": target of an archive upload. */
export function assertContainerPath(dir: string): string {
  if (!/^\/[A-Za-z0-9._/-]{0,300}$/.test(dir) || dir.split('/').includes('..')) throw new Error('Ungültiger Zielpfad im Container.');
  return dir;
}

