// TCP relay for ./dev-sandbox (see ../../sandbox). The dev server's container sits on an --internal
// Docker network with no route out; this container joins that network and the default bridge, and is
// the only way in. It forwards to one fixed destination, so the sandboxed app cannot use it to reach
// anything else. Plain TCP, so Vite's HMR websocket passes through unchanged.
import net from 'node:net';

const port = Number(process.env.SANDBOX_PORT);
const target = process.env.SANDBOX_TARGET;
if (!Number.isInteger(port) || port <= 0 || !target) {
  console.error('[sandbox-proxy] SANDBOX_PORT and SANDBOX_TARGET are required');
  process.exit(64);
}

net
  .createServer((client) => {
    const upstream = net.connect(port, target);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
    client.pipe(upstream);
    upstream.pipe(client);
  })
  .listen(port, '0.0.0.0', () => console.log(`[sandbox-proxy] :${port} -> ${target}:${port}`));
