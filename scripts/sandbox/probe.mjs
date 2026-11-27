// Isolation self-test for ./sandbox (see ../../sandbox). It runs in a sandbox container on the Docker
// daemon under test, with the same flags as the real phases, because runtimes differ (a Linux
// engine, the VM behind Docker Desktop, OrbStack or Colima) and a flag that isolates on one may not
// on another.
//
//   node probe.mjs none OWNER_FILE        a --network none phase: no interface but lo, no route, no
//                                         DNS, no internet; writes OWNER_FILE so the host can check
//                                         that bind-mounted files come out as the host user's
//   node probe.mjs internal PORT ADDR...  the dev server's internal network: no default route, no
//                                         DNS, no internet, none of ADDR (every Docker network
//                                         gateway and host address the host found) and no
//                                         host.docker.internal-style name reachable; then answers
//                                         HTTP on PORT so the host can check the relay. `!ADDR`
//                                         excludes an address (the relay's own, on this network)
//
// Prints one `ok`/`FAIL` line per check and finally `done <failures>`. Only an error that means "no
// route" counts as unreachable: a refused or reset connection means something answered, and a
// timeout proves nothing, so both fail the test.
import dns from 'node:dns/promises';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

const UNREACHABLE = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EACCES', 'EPERM']);
const CONNECT_TIMEOUT_MS = 6000;
const [mode, arg, ...given] = process.argv.slice(2);
let failures = 0;

function report(ok, what) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
}

/** Resolves to 'connected', 'timeout' or the connect error's code. */
function connect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
    const done = (outcome) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.once('connect', () => done('connected'));
    socket.once('timeout', () => done('timeout'));
    socket.once('error', (err) => done(err.code ?? String(err)));
  });
}

async function mustNotReach(host, port, label) {
  const outcome = await connect(host, port);
  report(UNREACHABLE.has(outcome), `${label} ${host}:${port} unreachable (${outcome})`);
}

async function mustNotResolve(name) {
  try {
    const { address } = await dns.lookup(name);
    report(false, `DNS ${name} does not resolve (resolved to ${address})`);
  } catch (err) {
    report(true, `DNS ${name} does not resolve (${err.code})`);
  }
}

function interfaces() {
  return readdirSync('/sys/class/net').sort();
}

/** Routes with destination 0.0.0.0/0 or ::/0. */
function defaultRoutes() {
  const v4 = readFileSync('/proc/net/route', 'utf-8')
    .split('\n')
    .slice(1)
    .filter((line) => line.split(/\s+/)[1] === '00000000');
  const v6 = existsSync('/proc/net/ipv6_route')
    ? readFileSync('/proc/net/ipv6_route', 'utf-8')
        .split('\n')
        .filter((line) => line.startsWith('00000000000000000000000000000000 00') && !/ lo$/.test(line.trim()))
    : [];
  return [...v4, ...v6];
}

const internet = () =>
  Promise.all([
    mustNotResolve('example.com'),
    mustNotReach('1.1.1.1', 443, 'internet'),
    mustNotReach('8.8.8.8', 53, 'internet'),
    mustNotReach('2606:4700:4700::1111', 443, 'internet'),
  ]);

const ipv4ToInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const intToIpv4 = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

/** The first and last host address of each of this container's subnets, which a gateway would use. */
function subnetEdges() {
  const own = [];
  const edges = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      own.push(a.address);
      const ip = ipv4ToInt(a.address);
      const mask = ipv4ToInt(a.netmask);
      const network = ip - (ip % (2 ** 32 - mask));
      const broadcast = network + (2 ** 32 - mask) - 1;
      edges.push(intToIpv4(network + 1), intToIpv4(broadcast - 1));
    }
  }
  return { own, edges: edges.filter((e) => !own.includes(e)) };
}

async function hostNames() {
  const names = ['host.docker.internal', 'gateway.docker.internal', 'host.lima.internal', 'host.orb.internal'];
  const found = [];
  for (const name of names) {
    try {
      const all = await dns.lookup(name, { all: true });
      report(false, `DNS ${name} does not resolve (resolved to ${all.map((a) => a.address).join(', ')})`);
      found.push(...all.map((a) => a.address));
    } catch (err) {
      report(true, `DNS ${name} does not resolve (${err.code})`);
    }
  }
  return found;
}

if (mode === 'none') {
  const ifaces = interfaces();
  report(ifaces.length === 1 && ifaces[0] === 'lo', `only the loopback interface (${ifaces.join(', ')})`);
  report(defaultRoutes().length === 0, 'no default route');
  await internet();
  writeFileSync(arg, 'scimgg-sandbox self-test\n');
  console.log(`done ${failures}`);
} else if (mode === 'internal') {
  const port = Number(arg);
  const ifaces = interfaces().filter((name) => name !== 'lo');
  report(ifaces.length === 1, `one interface besides loopback (${ifaces.join(', ')})`);
  const routes = defaultRoutes();
  report(routes.length === 0, `no default route${routes.length ? ` (${routes.join('; ')})` : ''}`);
  await internet();
  const { own, edges } = subnetEdges();
  const named = await hostNames();
  const excluded = new Set(given.filter((a) => a.startsWith('!')).map((a) => a.slice(1)));
  // `self` stands for this container's own address: reachable by definition, so the host can prove
  // that a reachable address makes the test fail.
  const listed = given
    .filter((a) => !a.startsWith('!'))
    .flatMap((a) => (a === 'self' ? own : [a]))
    .filter((a) => net.isIP(a));
  const targets = [...new Set([...listed, ...edges.filter((e) => !excluded.has(e)), ...named])];
  await Promise.all(targets.map((host) => mustNotReach(host, 9, 'gateway or host')));
  console.log(`done ${failures}`);
  http.createServer((_req, res) => res.end(`scimgg-sandbox-probe ${failures}\n`)).listen(port, '0.0.0.0');
} else {
  console.error('Usage: node probe.mjs none OWNER_FILE | internal PORT [ADDR...]');
  process.exit(64);
}
