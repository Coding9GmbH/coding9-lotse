import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Docker Engine client against a fake Engine API on a unix socket: version negotiation, pull progress, exec demux,
// label filter and the label check before stop/exec/remove (an unlabelled container is never touched).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-docker-'));
process.env.AICB_DATA = dir;
const sock = path.join(dir, 'docker.sock');
const IMAGE = 'dockware/shopware:6.7.15.1';

const calls: string[] = [];
let imageThere = false, pullError: string | null = null;
const containers: Record<string, { labels: Record<string, string>; state: string }> = {
  mine: { labels: { 'lotse.managed': '1', 'lotse.task': 't1' }, state: 'running' },
  foreign: { labels: { 'com.example': 'x' }, state: 'running' },
};
const frame = (stream: number, text: string) => { const b = Buffer.from(text); const h = Buffer.alloc(8); h[0] = stream; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
const send = (res: http.ServerResponse, status: number, body?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const read = (req: http.IncomingMessage) => new Promise<string>(ok => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => ok(b)); });
let lastExecBody: Record<string, unknown> | null = null, stdinSeen = '';

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://docker'), p = decodeURIComponent(u.pathname), body = await read(req);
  calls.push(`${req.method} ${p}${u.search}`);
  if (p === '/version') return send(res, 200, { ApiVersion: '1.47', MinAPIVersion: '1.24', Version: '27.0-fake' });
  if (p === '/_ping') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('OK'); }
  const m = /^\/v1\.41(\/.*)$/.exec(p);
  if (!m) return send(res, 400, { message: 'client version missing' });
  const r = m[1];
  if (r === `/images/${IMAGE}/json`) return imageThere ? send(res, 200, { Id: 'sha256:x' }) : send(res, 404, { message: 'No such image' });
  if (r === '/images/create') {
    assert.equal(u.searchParams.get('fromImage'), 'dockware/shopware');
    assert.equal(u.searchParams.get('tag'), '6.7.15.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"status":"Pulling from dockware/shopware","id":"6.7.15.1"}\n{"status":"Downloading","id":"aaa","progressDetail":{"current":50,"total":100}}\n{"status":"Downlo');
    res.write('ading","id":"bbb","progressDetail":{"current":0,"total":100}}\n');
    if (pullError) { res.end(`{"errorDetail":{"message":"${pullError}"},"error":"${pullError}"}\n`); return; }
    imageThere = true;
    return res.end('{"status":"Pull complete","id":"aaa"}\n{"status":"Pull complete","id":"bbb"}\n{"status":"Status: Downloaded newer image"}\n');
  }
  if (r === '/containers/json') return send(res, 200, [
    { Id: 'mine', Names: ['/lotse-t1'], Image: IMAGE, State: 'running', Labels: containers.mine.labels, NetworkSettings: { Networks: { 'lotse-sandbox': { IPAddress: '172.30.0.5' } } } },
    { Id: 'foreign', Names: ['/other'], Image: 'nginx', State: 'running', Labels: containers.foreign.labels }, // a proxy that ignores filters
  ]);
  if (r === '/containers/create') return send(res, 201, { Id: 'new1' });
  const c = /^\/containers\/([^/]+)\/(json|stop|start|exec|archive)$/.exec(r) ?? /^\/containers\/([^/]+)()$/.exec(r);
  if (c) {
    const box = containers[c[1]];
    if (!box) return send(res, 404, { message: 'No such container' });
    if (c[2] === 'json') return send(res, 200, { Id: c[1], Name: `/${c[1]}`, Config: { Image: IMAGE, Labels: box.labels }, State: { Status: box.state, Running: box.state === 'running' }, NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.9' }, 'lotse-sandbox': { IPAddress: '172.30.0.5' } } } });
    if (c[2] === 'stop') { box.state = 'exited'; return send(res, 204); }
    if (c[2] === 'exec') { lastExecBody = JSON.parse(body); return send(res, 201, { Id: 'exec1' }); }
    if (c[2] === '' && req.method === 'DELETE') { delete containers[c[1]]; return send(res, 204); }
  }
  if (r === '/exec/exec1/json') return send(res, 200, { ExitCode: 2 });
  if (r === '/networks/lotse-sandbox') return send(res, 404, { message: 'network not found' });
  send(res, 404, { message: `unknown ${r}` });
});
// exec start: hijacked connection (101), multiplexed frames, split across writes on purpose
server.on('upgrade', (req, socket) => {
  calls.push(`UPGRADE ${req.url}`);
  socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
  socket.on('data', (d: Buffer) => { stdinSeen += d.toString(); });
  const all = Buffer.concat([frame(1, 'hello '), frame(2, 'warn\n'), frame(1, 'world\n')]);
  socket.write(all.subarray(0, 5));
  setTimeout(() => { socket.write(all.subarray(5, 17)); socket.end(all.subarray(17)); }, 10);
});
await new Promise<void>(ok => server.listen(sock, ok));
after(() => new Promise<void>(ok => server.close(() => ok())));

const { DockerEngine, parseDockerHost, pickApiVersion, createDemuxer, pullProgressParser } = await import('../../src/server/sandbox/docker-engine');
const d = new DockerEngine({ socketPath: sock });

test('DOCKER_HOST: unix socket and tcp, everything else is refused', () => {
  assert.deepEqual(parseDockerHost(''), { socketPath: '/var/run/docker.sock' });
  assert.deepEqual(parseDockerHost('unix:///run/user/1000/docker.sock'), { socketPath: '/run/user/1000/docker.sock' });
  assert.deepEqual(parseDockerHost('tcp://docker-proxy:2375'), { host: 'docker-proxy', port: 2375 });
  for (const bad of ['ssh://user@host', 'https://docker:2376', 'tcp://a b:1', 'tcp://host']) assert.throws(() => parseDockerHost(bad), /DOCKER_HOST/, bad);
});

test('API version: 1.41 unless the daemon requires a newer minimum', () => {
  assert.equal(pickApiVersion({ ApiVersion: '1.56', MinAPIVersion: '1.40' }), '1.41');
  assert.equal(pickApiVersion({ ApiVersion: '1.56', MinAPIVersion: '1.44' }), '1.44');
  assert.equal(pickApiVersion({}), '1.41');
});

test('ping and version', async () => {
  await d.ping();
  assert.deepEqual(await d.version(), { apiVersion: '1.47', version: '27.0-fake' });
});

test('pull progress: JSON lines split across chunks, percentage over all layers, error line', () => {
  const seen: { text: string; pct?: number }[] = [];
  const p = pullProgressParser(x => seen.push(x));
  p.push(Buffer.from('{"status":"Downloading","id":"a","progressDetail":{"current":25,"total":100}}\n{"status":"Downl'));
  p.push(Buffer.from('oading","id":"b","progressDetail":{"current":75,"total":100}}\n'));
  assert.equal(seen.at(-1)?.pct, 50);
  p.push(Buffer.from('{"status":"Pull complete","id":"a"}\n'));
  assert.equal(seen.at(-1)?.pct, 88);
  assert.equal(p.end(), null);
  const q = pullProgressParser(() => {});
  q.push(Buffer.from('{"error":"manifest unknown"}'));
  assert.equal(q.end(), 'manifest unknown');
});

test('ensureImage: inspect, pull with progress, then present', async () => {
  const progress: number[] = [];
  assert.equal(await d.imagePresent(IMAGE), false);
  assert.deepEqual(await d.ensureImage(IMAGE, p => { if (p.pct !== undefined) progress.push(p.pct); }), { pulled: true });
  assert.ok(progress.includes(25) && progress.at(-1) === 100, `progress ${progress}`);
  assert.deepEqual(await d.ensureImage(IMAGE), { pulled: false });
  imageThere = false; pullError = 'manifest for dockware/shopware:6.7.15.1 not found';
  await assert.rejects(d.ensureImage(IMAGE), /gibt es nicht/);
  pullError = null;
  await assert.rejects(d.ensureImage('dockware/shopware:latest'), /nicht erlaubt/);
  await assert.rejects(d.ensureImage('evil/image:1.0'), /nicht erlaubt/);
});

test('demuxer: frames split at any byte, stdout and stderr in order', () => {
  const out: string[] = [];
  const push = createDemuxer((s, b) => out.push(`${s}:${b}`));
  const all = Buffer.concat([frame(1, 'ab'), frame(2, 'cd'), frame(1, '')]);
  for (let i = 0; i < all.length; i++) push(all.subarray(i, i + 1));
  assert.deepEqual(out, ['1:ab', '2:cd', '1:']);
});

test('exec: upgrade, demux, stdin, exit code; argv as an array (no shell)', async () => {
  const r = await d.exec('mine', ['bin/console', 'theme:compile'], { user: 'www-data', workdir: '/var/www/html', timeoutMs: 5000, stdin: Buffer.from('input') });
  assert.deepEqual(r, { exitCode: 2, output: 'hello warn\nworld\n', truncated: false });
  assert.deepEqual(lastExecBody?.Cmd, ['bin/console', 'theme:compile']);
  assert.equal(lastExecBody?.User, 'www-data');
  assert.equal(lastExecBody?.AttachStdin, true);
  assert.equal(stdinSeen.endsWith('input'), true);
  const cut = await d.exec('mine', ['true'], { user: 'www-data', timeoutMs: 5000, maxOutput: 6 });
  assert.deepEqual(cut, { exitCode: 2, output: 'world\n', truncated: true }, 'keeps the end of the output');
  await assert.rejects(d.exec('mine', ['a\0b'], { user: 'www-data', timeoutMs: 1000 }), /Ungültiger Befehl/);
});

test('list: filter by label, and unlabelled containers are dropped even if the daemon returns them', async () => {
  const list = await d.list({ 'lotse.task': 't1' });
  assert.deepEqual(list.map(c => [c.id, c.name, c.address]), [['mine', 'lotse-t1', { host: '172.30.0.5', port: 80 }]]);
  assert.deepEqual((await d.inspect('mine'))?.address, { host: '172.30.0.5', port: 80 }, 'only the address on lotse-sandbox, never another network');
  const q = calls.findLast(c => c.startsWith('GET /v1.41/containers/json'))!;
  const filters = JSON.parse(new URLSearchParams(q.split('?')[1]).get('filters')!);
  assert.deepEqual(filters.label.sort(), ['lotse.managed=1', 'lotse.task=t1']);
});

test('stop/exec/remove/archive on an unlabelled container are refused before any write', async () => {
  const before = calls.length;
  await assert.rejects(d.stop('foreign'), /nicht von Lotse verwaltet/);
  await assert.rejects(d.exec('foreign', ['id'], { user: 'root', timeoutMs: 1000 }), /nicht von Lotse verwaltet/);
  await assert.rejects(d.remove('foreign'), /nicht von Lotse verwaltet/);
  await assert.rejects(d.putArchive('foreign', '/tmp', Buffer.alloc(1024)), /nicht von Lotse verwaltet/);
  const writes = calls.slice(before).filter(c => !c.startsWith('GET '));
  assert.deepEqual(writes, [], 'only inspects reached Docker');
  assert.equal(containers.foreign.state, 'running');
  await assert.rejects(d.stop('../../etc'), /Container-ID/);
  await d.stop('mine');
  assert.equal(containers.mine.state, 'exited');
});

test('create: only labelled, allowed image, no host access', async () => {
  const base = { name: 'lotse-t1', Image: IMAGE, Labels: { 'lotse.managed': '1' }, HostConfig: { NetworkMode: 'lotse-sandbox' } };
  assert.equal(await d.create(base), 'new1');
  const before = calls.length;
  await assert.rejects(d.create({ ...base, Labels: {} }), /Lotse-Label/);
  await assert.rejects(d.create({ ...base, Image: 'dockware/shopware:latest' }), /nicht erlaubt/);
  await assert.rejects(d.create({ ...base, HostConfig: { Privileged: true } }), /Privileged/);
  await assert.rejects(d.create({ ...base, HostConfig: { Binds: ['/:/host'] } }), /Binds/);
  await assert.rejects(d.create({ ...base, HostConfig: { NetworkMode: 'host' } }), /NetworkMode=host/);
  await assert.rejects(d.create({ ...base, HostConfig: { NetworkMode: 'bridge' } }), /NetworkMode=bridge/, 'the default bridge has internet access');
  await assert.rejects(d.create({ ...base, HostConfig: {} }), /muss lotse-sandbox sein/, 'missing = default bridge');
  await assert.rejects(d.create({ ...base, name: 'web' }), /Container-Name/);
  // allow-list: Docker matches keys case-insensitively, so other spellings are refused, as is anything not on the list
  const bad = (spec: Record<string, unknown>, re: RegExp) => assert.rejects(d.create({ ...base, ...spec } as never), re, JSON.stringify(spec));
  await bad({ HostConfig: { privileged: true } }, /privileged ist nicht erlaubt/);
  await bad({ HostConfig: { binds: ['/:/host'] } }, /binds/);
  await bad({ HostConfig: { capAdd: ['SYS_ADMIN'] } }, /capAdd/);
  await bad({ image: 'nginx:1' }, /image ist nicht erlaubt/);
  await bad({ hostConfig: { Privileged: true } }, /hostConfig/);
  for (const mode of ['container:lotse', 'none', 'lotse_docker-api', 'HOST']) await bad({ HostConfig: { NetworkMode: mode } }, /NetworkMode=/);
  for (const k of ['PidMode', 'IpcMode', 'SecurityOpt', 'Sysctls', 'CgroupParent', 'Runtime', 'PublishAllPorts', 'Devices', 'Mounts', 'VolumesFrom', 'UsernsMode'])
    await bad({ HostConfig: { [k]: k === 'PublishAllPorts' ? true : ['x'] } }, new RegExp(`${k} ist nicht erlaubt`));
  await bad({ HostConfig: { NetworkMode: 'lotse-sandbox', PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } } }, /PortBindings ist nicht erlaubt/);
  await bad({ ExposedPorts: { '80/tcp': {} } }, /ExposedPorts ist nicht erlaubt/);
  await bad({ HostConfig: { LogConfig: { Type: 'syslog', Config: { 'syslog-address': 'tcp://x' } } } }, /Type/);
  await bad({ NetworkingConfig: { EndpointsConfig: { 'lotse_docker-api': {} } } }, /lotse_docker-api ist nicht erlaubt/);
  await bad({ NetworkingConfig: { EndpointsConfig: { 'lotse-sandbox': { IPAMConfig: { IPv4Address: '10.0.0.1' } } } } }, /IPAMConfig/);
  await bad({ Volumes: { '/data': {} } }, /Volumes ist nicht erlaubt/);
  assert.equal(calls.length, before, 'nothing sent');
  // what the template builds: limits, the internal network only
  assert.equal(await d.create({ ...base, Env: ['A=1'], Hostname: 'lotse-t1',
    HostConfig: { Memory: 4096 * 2 ** 20, NanoCpus: 2e9, PidsLimit: 2048, NetworkMode: 'lotse-sandbox', RestartPolicy: { Name: 'no' }, Tmpfs: { '/tmp': 'size=512m' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m' } } },
    NetworkingConfig: { EndpointsConfig: { 'lotse-sandbox': { Aliases: ['lotse-t1'] } } } }), 'new1');
});

test('unreachable socket: clear German message', async () => {
  const gone = new DockerEngine({ socketPath: path.join(dir, 'missing.sock') });
  await assert.rejects(gone.ping(), /Docker ist nicht erreichbar/);
});
