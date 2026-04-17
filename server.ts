/**
 * LPOS Custom Server
 *
 * Wraps the Next.js app with a standard Node.js HTTP server,
 * attaches Socket.io, and initializes all LPOS services on startup.
 *
 * HTTPS is handled by Tailscale — this server runs plain HTTP.
 *
 * Start with:
 *   npm run dev    → development (HMR, verbose logging)
 *   npm start      → production
 */

import { createServer as createHttpServer } from 'node:http';
import { parse } from 'node:url';
import { parse as parseCookies } from 'cookie';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import type { Socket } from 'socket.io';
import { initServices, stopServices, getRegistry } from './lib/services/container';
import { APP_SESSION_COOKIE, verifySessionToken } from './lib/services/session-auth';

const dev      = process.env.NODE_ENV !== 'production';
const port     = parseInt(process.env.PORT ?? '3000', 10);
const hostname = process.env.HOSTNAME ?? '0.0.0.0';

async function main() {
  const nextApp = next({ dev, hostname, port });
  const handle  = nextApp.getRequestHandler();

  await nextApp.prepare();

  const requestHandler = async (
    req:  Parameters<typeof handle>[0],
    res:  Parameters<typeof handle>[1],
  ) => {
    try {
      const parsedUrl = parse(req.url ?? '/', true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('[lpos] request error:', err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  };

  const httpServer = createHttpServer(requestHandler);

  // ── Upload timeout ─────────────────────────────────────────────────────────
  // Node.js 18+ defaults requestTimeout to 300 s (5 min), which kills large
  // file uploads mid-stream before the route handler can finish writing.
  // Disable it on this local server — timeouts are handled at the application
  // layer (ingest queue stale sweep) rather than the transport layer.
  httpServer.requestTimeout = 0;

  // ── Socket.io ──────────────────────────────────────────────────────────────

  const allowedOrigins = [
    process.env.APP_BASE_URL,
    process.env.APP_LOCAL_URL,
  ].filter(Boolean) as string[];
  const io = new SocketIOServer(httpServer, {
    cors: { origin: allowedOrigins.length ? allowedOrigins : false },
  });

  // Authenticate sockets via session cookie and place them in a user-specific room.
  // Guest/unauthenticated sockets are still allowed (for non-user events like
  // services:status) but won't join a user room so they won't receive task notifications.
  io.use(async (socket: Socket, next: (err?: Error) => void) => {
    const raw = socket.handshake.headers.cookie ?? '';
    const cookieJar = parseCookies(raw);
    const session = await verifySessionToken(cookieJar[APP_SESSION_COOKIE]);
    (socket as Socket & { userId?: string }).userId = session?.userId;
    next();
  });

  io.on('connection', (socket) => {
    const uid = (socket as Socket & { userId?: string }).userId;
    if (uid) socket.join(`user:${uid}`);
    socket.emit('services:status', getRegistry().list());
  });

  // ── Services ───────────────────────────────────────────────────────────────

  await initServices(io);

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      process.stdout.write(`\n[lpos] shutting down (${signal})...\n`);
      await stopServices();
      httpServer.close(() => {
        process.stdout.write('[lpos] goodbye\n');
        // Always exit 0 so launchd's KeepAlive (SuccessfulExit: false) stays
        // hands-off. When a restart is initiated the detached child runs
        // `npm run build && launchctl kickstart -k` — the kickstart handles
        // bringing the server back up once the build is complete. Exiting 1
        // here would cause launchd to restart mid-build against a partially
        // written .next/ directory, which breaks startup.
        process.exit(0);
      });
    });
  }

  // ── Listen ─────────────────────────────────────────────────────────────────

  httpServer.listen(port, () => {
    const services = getRegistry()
      .list()
      .map((s) => `${s.name} (${s.status})`)
      .join('  ·  ');

    console.log('');
    console.log(`  ▲ LPOS  http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}`);
    console.log('  ↳ HTTPS handled by Tailscale');
    console.log(`  ↳ ${services}`);
    console.log('');
  });
}

main().catch((err) => {
  console.error('[lpos] failed to start:', err);
  process.exit(1);
});
