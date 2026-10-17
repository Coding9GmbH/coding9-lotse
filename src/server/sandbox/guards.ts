import 'server-only';
// Guards shared by both runner implementations: labels, ids, paths, image and container spec.
import { TEMPLATES } from './templates';
import type { ContainerSpec, NetworkInfo } from './runner';
import { EGRESS_NET, MANAGED_LABEL, SANDBOX_NET } from './labels';

export { MANAGED, MANAGED_LABEL, TASK_LABEL } from './labels';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export function assertId(id: string): string {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Ungültige Container-ID.');
  return id;
}
/** Only an image that one of the registered templates allows (pinned dockware/shopware or dockware/play). */
export function assertAllowedImage(image: string): string {
  if (!Object.values(TEMPLATES).some(t => t.imagePattern.test(image))) throw new Error(`Image „${image}“ ist nicht erlaubt (nur dockware/shopware mit fester Version).`);
  return image;
}
export const isManaged = (labels: Record<string, string> | null | undefined) => labels?.[MANAGED_LABEL] === '1';
export function assertManaged<T extends { labels: Record<string, string> } | null>(c: T): NonNullable<T> {
  if (!c) throw new Error('Container nicht gefunden.');
  if (!isManaged(c.labels)) throw new Error('Container wird nicht von Lotse verwaltet: Zugriff verweigert.');
  return c as NonNullable<T>;
}
// Allow-list of the create body. Docker decodes JSON keys case-insensitively, so only the exact canonical spelling passes
// (a "privileged" or a second "image" can never slip past a check that looked at "Privileged"/"Image").
type Check = (v: unknown, k: string) => void;
const deny = (msg: string): never => { throw new Error(`Container-Spezifikation abgelehnt: ${msg}`); };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const obj = (v: unknown, k: string) => (isObj(v) ? v : deny(`${k} muss ein Objekt sein.`));
const only = (o: Record<string, unknown>, checks: Record<string, Check>, where: string) => {
  for (const [k, v] of Object.entries(o)) {
    const c = Object.hasOwn(checks, k) ? checks[k] : null;
    if (!c) deny(`${where ? `${where}.` : ''}${k} ist nicht erlaubt.`);
    else if (v !== undefined) c(v, k);
  }
};
const str = (re: RegExp): Check => (v, k) => { if (typeof v !== 'string' || !re.test(v)) deny(`${k} hat einen unzulässigen Wert.`); };
const posNum: Check = (v, k) => { if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) deny(`${k} muss eine positive Zahl sein.`); };
const strings: Check = (v, k) => { if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) deny(`${k} muss eine Liste von Texten sein.`); };
const record = (keyRe: RegExp, val: Check): Check => (v, k) => { for (const [kk, vv] of Object.entries(obj(v, k))) { if (!keyRe.test(kk)) deny(`${k}: Schlüssel „${kk.slice(0, 60)}“ ist nicht erlaubt.`); val(vv, `${k}.${kk}`); } };
const anyStr: Check = (v, k) => { if (typeof v !== 'string') deny(`${k} muss ein Text sein.`); };

const HOST: Record<string, Check> = {
  Memory: posNum, NanoCpus: posNum, PidsLimit: posNum,
  // dropping capabilities only makes it narrower; CapAdd/Privileged/SecurityOpt stay outside the list
  CapDrop: (v, k) => { strings(v, k); if ((v as string[]).some(c => !/^[A-Z_]{2,30}$/.test(c))) deny(`${k} hat einen unzulässigen Wert.`); },
  // the internal sandbox network only: never host, none, bridge (egress), container:<id> or another network (docker-api!)
  NetworkMode: (v, k) => { if (v !== SANDBOX_NET) deny(`${k}=${String(v).slice(0, 60)} ist nicht erlaubt.`); },
  RestartPolicy: (v, k) => only(obj(v, k), { Name: str(/^(no|on-failure|unless-stopped)?$/), MaximumRetryCount: (n, kk) => { if (!Number.isInteger(n) || (n as number) < 0) deny(`${kk} hat einen unzulässigen Wert.`); } }, k),
  Tmpfs: record(/^\/[A-Za-z0-9._/-]{1,200}$/, str(/^[A-Za-z0-9=,]{0,200}$/)),
  // logs stay with Docker: no driver that ships them over the network
  LogConfig: (v, k) => only(obj(v, k), { Type: str(/^(json-file|local|none)$/), Config: record(/^[a-z-]{1,40}$/, str(/^[A-Za-z0-9.]{1,20}$/)) }, k),
};
const TOP: Record<string, Check> = {
  name: () => {}, Image: () => {}, Labels: record(/^[A-Za-z0-9._-]{1,100}$/, anyStr), Env: strings,
  Hostname: str(/^[a-z0-9][a-z0-9-]{0,62}$/),
  HostConfig: (v, k) => only(obj(v, k), HOST, k),
  // at most the internal sandbox network as endpoint
  NetworkingConfig: (v, k) => only(obj(v, k), { EndpointsConfig: (e, kk) => only(obj(e, kk), { [SANDBOX_NET]: (ep, kkk) => only(obj(ep, kkk), { Aliases: strings }, kkk) }, `${k}.${kk}`) }, k),
};
/** Second line of defence behind the template's spec builder: an allow-list, nothing that reaches the host, Lotse or the Docker API. */
export function assertSafeSpec(spec: ContainerSpec): ContainerSpec {
  if (!isObj(spec)) deny('kein Objekt.');
  only(spec as unknown as Record<string, unknown>, TOP, '');
  if (typeof spec.name !== 'string' || !/^lotse-[a-z0-9-]{1,60}$/.test(spec.name)) throw new Error('Ungültiger Container-Name.');
  if (!isManaged(spec.Labels)) throw new Error('Container ohne Lotse-Label werden nicht angelegt.');
  // a missing NetworkMode means Docker's default bridge, i.e. internet access: the internal network is mandatory
  if ((spec.HostConfig as { NetworkMode?: unknown } | undefined)?.NetworkMode !== SANDBOX_NET) deny(`HostConfig.NetworkMode muss ${SANDBOX_NET} sein (kein Internetzugang).`);
  assertAllowedImage(spec.Image);
  return spec;
}
/** Lotse creates only its two networks: the internal one and the egress one for approved internet access. */
export function assertNetworkName(name: string): string {
  if (name !== SANDBOX_NET && name !== EGRESS_NET) throw new Error(`Netzwerk „${String(name).slice(0, 60)}“ wird von Lotse nicht angelegt.`);
  return name;
}
/** Before attaching a container for internet access: the egress network exists, belongs to Lotse and is a plain bridge with egress. */
export function assertEgressNetwork(n: NetworkInfo | null): NetworkInfo {
  if (!n) throw new Error(`Das Docker-Netzwerk „${EGRESS_NET}“ fehlt.`);
  if (!isManaged(n.labels)) throw new Error(`Das Docker-Netzwerk „${EGRESS_NET}“ gehört nicht zu Lotse (Label lotse.managed=1 fehlt).`);
  if (n.internal) throw new Error(`Das Docker-Netzwerk „${EGRESS_NET}“ ist intern – darüber gibt es kein Internet. Netzwerk entfernen (docker network rm ${EGRESS_NET}), Lotse legt es neu an.`);
  return n;
}
/** Absolute container path without "..": target of an archive upload. */
export function assertContainerPath(dir: string): string {
  if (!/^\/[A-Za-z0-9._/-]{0,300}$/.test(dir) || dir.split('/').includes('..')) throw new Error('Ungültiger Zielpfad im Container.');
  return dir;
}

