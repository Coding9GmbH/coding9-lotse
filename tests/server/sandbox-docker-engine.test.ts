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
const containers: Record<string, { labels: Record<string, string>; state: string; egress?: boolean; exitCode?: number; oom?: boolean }> = {
  mine: { labels: { 'lotse.managed': '1', 'lotse.task': 't1' }, state: 'running' },
  foreign: { labels: { 'com.example': 'x' }, state: 'running' },
};
const frame = (stream: number, text: string) => { const b = Buffer.from(text); const h = Buffer.alloc(8); h[0] = stream; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
const send = (res: http.ServerResponse, status: number, body?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const read = (req: http.IncomingMessage) => new Promise<string>(ok => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => ok(b)); });
let lastExecBody: Record<string, unknown> | null = null, stdinSeen = '';
let egressNet: Record<string, unknown> | null = null;
const netBodies: Record<string, unknown>[] = [];

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
  const c = /^\/containers\/([^/]+)\/(json|stop|start|exec|archive|wait|logs)$/.exec(r) ?? /^\/containers\/([^/]+)()$/.exec(r);
  if (c) {
    const box = containers[c[1]];
    if (!box) return send(res, 404, { message: 'No such container' });
    if (c[2] === 'json') return send(res, 200, { Id: c[1], Name: `/${c[1]}`, Config: { Image: IMAGE, Labels: box.labels }, State: { Status: box.state, Running: box.state === 'running', ExitCode: box.exitCode ?? 0, OOMKilled: !!box.oom }, NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.9' }, 'lotse-sandbox': { IPAddress: '172.30.0.5' }, ...(box.egress ? { 'lotse-sandbox-egress': { IPAddress: '10.214.0.2' } } : {}) } } });
    if (c[2] === 'stop') { box.state = 'exited'; return send(res, 204); }
    if (c[2] === 'logs') { // no TTY: the same multiplexed frames as an exec
      assert.deepEqual([u.searchParams.get('stdout'), u.searchParams.get('stderr'), u.searchParams.get('tail')], ['1', '1', '20']);
      res.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream' }); return res.end(Buffer.concat([frame(1, ' * Starting MySQL database server mysqld\n'), frame(2, '   ...fail!\n')]));
    }
    if (c[2] === 'exec') { lastExecBody = JSON.parse(body); return send(res, 201, { Id: lastExecBody?.Tty ? 'tty1' : 'exec1' }); }
    if (c[2] === 'wait') { assert.equal(u.searchParams.get('condition'), 'not-running'); return send(res, 200, { StatusCode: 3 }); }
    if (c[2] === 'archive' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/x-tar' }); return res.end(Buffer.alloc(Number(u.searchParams.get('path') === '/big' ? 300_000 : 2048), 7)); }
    if (c[2] === '' && req.method === 'DELETE') { delete containers[c[1]]; return send(res, 204); }
  }
  if (r === '/exec/exec1/json') return send(res, 200, { ExitCode: 2 });
  if (r === '/exec/tty1/resize') { resizes.push(`${u.searchParams.get('w')}x${u.searchParams.get('h')}`); return send(res, 201); }
  if (r === '/networks/lotse-sandbox') return send(res, 404, { message: 'network not found' });
  if (r === '/networks/lotse-sandbox-egress' && req.method === 'GET') return egressNet ? send(res, 200, egressNet) : send(res, 404, { message: 'network not found' });
  if (r === '/networks/create') { netBodies.push(JSON.parse(body)); return send(res, 201, { Id: 'n1' }); }
  const n = /^\/networks\/lotse-sandbox-egress\/(connect|disconnect)$/.exec(r);
  if (n) { const b = JSON.parse(body) as { Container: string }; netBodies.push({ op: n[1], ...b }); containers[b.Container].egress = n[1] === 'connect'; return send(res, 200); }
  send(res, 404, { message: `unknown ${r}` });
});
// exec start: hijacked connection (101), multiplexed frames, split across writes on purpose
// console (Tty): one raw stream, no frames; the "shell" greets with a prompt (in the same packet as the 101) and echoes upper case
const resizes: string[] = [];
server.on('upgrade', (req, socket) => {
  calls.push(`UPGRADE ${req.url}`);
  if (req.url?.includes('/exec/tty1/')) {
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n$ ');
    socket.on('data', (d: Buffer) => { if (d.toString() === 'exit\r') socket.end('bye\r\n'); else socket.write(d.toString().toUpperCase()); });
    return;
  }
  socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
  socket.on('data', (d: Buffer) => { stdinSeen += d.toString(); });
  const all = Buffer.concat([frame(1, 'hello '), frame(2, 'warn\n'), frame(1, 'world\n')]);
  socket.write(all.subarray(0, 5));
  setTimeout(() => { socket.write(all.subarray(5, 17)); socket.end(all.subarray(17)); }, 10);
});
await new Promise<void>(ok => server.listen(sock, ok));
after(() => new Promise<void>(ok => server.close(() => ok())));

const { DockerEngine, parseDockerHost, pickApiVersion, createDemuxer, demuxLog, pullProgressParser } = await import('../../src/server/sandbox/docker-engine');
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

test('console: exec with Tty on a hijacked connection that stays open both ways, raw bytes (no frames), resize; label check first', async () => {
  const tty = await d.openTty('mine', ['bash', '-l'], { user: 'dockware', workdir: '/var/www/html', env: ['TERM=xterm-256color'], cols: 120, rows: 40 });
  assert.deepEqual(lastExecBody, { Cmd: ['bash', '-l'], User: 'dockware', WorkingDir: '/var/www/html', Env: ['TERM=xterm-256color'], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true });
  assert.deepEqual(resizes, ['120x40'], 'the initial size right after the start');
  let out = '', ended = false;
  await new Promise(r => setTimeout(r, 20));
  tty.onData(b => { out += b.toString(); }); // registered late: what arrived before (the prompt) is not lost
  tty.onEnd(() => { ended = true; });
  tty.write('ls\r');
  await tty.resize(100, 30);
  assert.deepEqual(resizes, ['120x40', '100x30']);
  const until = async (fn: () => boolean) => { const end = Date.now() + 2000; while (!fn()) { if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(out)}`); await new Promise(r => setTimeout(r, 5)); } };
  await until(() => out === '$ LS\r');
  tty.write('exit\r');
  await until(() => ended);
  assert.equal(out, '$ LS\rbye\r\n');
  const n = calls.length;
  await assert.rejects(d.openTty('foreign', ['bash'], { user: 'root', workdir: '/', env: [], cols: 80, rows: 24 }), /nicht von Lotse verwaltet/);
  assert.deepEqual(calls.slice(n).filter(c => !c.startsWith('GET ')), [], 'nothing created in a foreign container');
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

test('logs: demultiplexed stdout and stderr of a managed container only; inspect reports exit code and OOM kill', async () => {
  containers.crashed = { labels: { 'lotse.managed': '1', 'lotse.task': 't2' }, state: 'exited', exitCode: 1, oom: true };
  assert.equal(await d.logs('crashed', { tail: 20 }), ' * Starting MySQL database server mysqld\n   ...fail!\n');
  const info = await d.inspect('crashed');
  assert.deepEqual([info?.running, info?.exitCode, info?.oomKilled], [false, 1, true]);
  assert.equal((await d.inspect('foreign'))?.oomKilled, undefined);
  const before = calls.length;
  await assert.rejects(d.logs('foreign', { tail: 20 }), /nicht von Lotse verwaltet/);
  assert.ok(!calls.slice(before).some(c => c.includes('/logs')), 'never read from a foreign container');
  assert.equal(demuxLog(Buffer.from('plain text log\n')), 'plain text log\n', 'a TTY container: plain text');
  delete containers.crashed;
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
  for (const k of ['PidMode', 'IpcMode', 'Sysctls', 'CgroupParent', 'Runtime', 'PublishAllPorts', 'Devices', 'Mounts', 'VolumesFrom', 'UsernsMode'])
    await bad({ HostConfig: { [k]: k === 'PublishAllPorts' ? true : ['x'] } }, new RegExp(`${k} ist nicht erlaubt`));
  await bad({ HostConfig: { NetworkMode: 'lotse-sandbox', PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } } }, /PortBindings ist nicht erlaubt/);
  await bad({ ExposedPorts: { '80/tcp': {} } }, /ExposedPorts ist nicht erlaubt/);
  await bad({ HostConfig: { LogConfig: { Type: 'syslog', Config: { 'syslog-address': 'tcp://x' } } } }, /Type/);
  await bad({ NetworkingConfig: { EndpointsConfig: { 'lotse_docker-api': {} } } }, /lotse_docker-api ist nicht erlaubt/);
  await bad({ NetworkingConfig: { EndpointsConfig: { 'lotse-sandbox': { IPAMConfig: { IPv4Address: '10.0.0.1' } } } } }, /IPAMConfig/);
  await bad({ Volumes: { '/data': {} } }, /Volumes ist nicht erlaubt/);
  await bad({ HostConfig: { NetworkMode: 'lotse-sandbox', SecurityOpt: ['seccomp=unconfined'] } }, /SecurityOpt hat einen unzulässigen Wert/);
  // a task container runs the image's own start command: no Cmd, no User
  await bad({ Cmd: ['bash', '-c', 'curl evil'] }, /Befehl oder Benutzer nicht erlaubt/);
  await bad({ User: 'root' }, /Befehl oder Benutzer nicht erlaubt/);
  assert.equal(calls.length, before, 'nothing sent');
  // what the template builds: limits, the internal network only
  assert.equal(await d.create({ ...base, Env: ['A=1'], Hostname: 'lotse-t1',
    HostConfig: { Memory: 4096 * 2 ** 20, NanoCpus: 2e9, PidsLimit: 2048, NetworkMode: 'lotse-sandbox', RestartPolicy: { Name: 'no' }, Tmpfs: { '/tmp': 'size=512m' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m' } } },
    NetworkingConfig: { EndpointsConfig: { 'lotse-sandbox': { Aliases: ['lotse-t1'] } } } }), 'new1');
});

test('screenshots: the fixed screenshot spec is accepted; wait and getArchive only on managed containers, archive size capped', async () => {
  const { buildShotSpec } = await import('../../src/server/sandbox/screenshot-spec');
  const spec = buildShotSpec('t_abcdefghijkl');
  assert.equal(await d.create(spec), 'new1');
  const bad = (o: Record<string, unknown>, re: RegExp) => assert.rejects(d.create({ ...spec, ...o } as never), re);
  await bad({ Cmd: ['bash', '-c', 'id'] }, /Befehl oder Benutzer des Screenshot-Containers/);
  await bad({ User: 'root' }, /Befehl oder Benutzer des Screenshot-Containers/);
  await bad({ HostConfig: { ...spec.HostConfig, CapDrop: ['NET_RAW'] } }, /CapDrop ALL/);
  await bad({ HostConfig: { ...spec.HostConfig, SecurityOpt: [] } }, /no-new-privileges/);
  await bad({ Labels: { 'lotse.managed': '1' } }, /Label des Screenshot-Containers/);
  await bad({ name: 'lotse-t-abcdefghijkl' }, /Name oder Label/);
  await bad({ Env: ['A=1'] }, /ohne Umgebung/);
  await bad({ HostConfig: { ...spec.HostConfig, NetworkMode: 'bridge' } }, /NetworkMode=bridge/);
  assert.equal(await d.wait('mine', { timeoutMs: 5000 }), 3);
  assert.equal((await d.getArchive('mine', '/lotse/out', { maxBytes: 4096 })).length, 2048);
  await assert.rejects(d.getArchive('mine', '/big', { maxBytes: 100_000 }), /zu groß/);
  await assert.rejects(d.getArchive('mine', '/lotse/../etc', { maxBytes: 4096 }), /Zielpfad/);
  const n = calls.length;
  await assert.rejects(d.wait('foreign', { timeoutMs: 5000 }), /nicht von Lotse verwaltet/);
  await assert.rejects(d.getArchive('foreign', '/lotse/out', { maxBytes: 4096 }), /nicht von Lotse verwaltet/);
  assert.ok(!calls.slice(n).some(c => /foreign\/(wait|archive)/.test(c)), 'nothing asked of the foreign container');
});

test('unreachable socket: clear German message', async () => {
  const gone = new DockerEngine({ socketPath: path.join(dir, 'missing.sock') });
  await assert.rejects(gone.ping(), /Docker ist nicht erreichbar/);
});

test('internet: only the Lotse egress network, created without traffic between its containers; connect/disconnect only managed containers, idempotent', async () => {
  containers.net = { labels: { 'lotse.managed': '1', 'lotse.task': 't2' }, state: 'running' };
  await assert.rejects(d.createNetwork('bridge', { internal: false, labels: {} }), /nicht angelegt/);
  await d.createNetwork('lotse-sandbox-egress', { internal: false, icc: false, labels: { 'lotse.managed': '1' }, subnet: '10.214.0.0/24' });
  assert.deepEqual(netBodies.at(-1), { Name: 'lotse-sandbox-egress', Driver: 'bridge', Internal: false, Labels: { 'lotse.managed': '1' }, CheckDuplicate: true,
    Options: { 'com.docker.network.bridge.enable_icc': 'false' }, IPAM: { Config: [{ Subnet: '10.214.0.0/24' }] } });
  await assert.rejects(d.connectEgress('net'), /fehlt/, 'no network, no connect');
  egressNet = { Name: 'lotse-sandbox-egress', Internal: false, Labels: {}, Options: { 'com.docker.network.bridge.enable_icc': 'false' } };
  await assert.rejects(d.connectEgress('net'), /gehört nicht zu Lotse/);
  egressNet = { ...egressNet, Labels: { 'lotse.managed': '1' }, Internal: true };
  await assert.rejects(d.connectEgress('net'), /intern/);
  egressNet = { ...egressNet, Internal: false };
  const n = await d.inspectNetwork('lotse-sandbox-egress');
  assert.equal(n?.icc, false);
  const before = netBodies.length;
  await assert.rejects(d.connectEgress('foreign'), /nicht von Lotse verwaltet/);
  assert.equal(netBodies.length, before, 'a foreign container is never attached');
  await d.connectEgress('net');
  assert.deepEqual(netBodies.at(-1), { op: 'connect', Container: 'net' });
  assert.deepEqual((await d.inspect('net'))?.networks.sort(), ['bridge', 'lotse-sandbox', 'lotse-sandbox-egress']);
  await d.connectEgress('net');
  assert.equal(netBodies.length, before + 1, 'already attached: nothing sent');
  await d.disconnectEgress('net');
  assert.deepEqual(netBodies.at(-1), { op: 'disconnect', Container: 'net', Force: true });
  await d.disconnectEgress('net');
  await d.disconnectEgress('gone');
  assert.equal(netBodies.length, before + 2, 'not attached or missing: nothing sent');
});
