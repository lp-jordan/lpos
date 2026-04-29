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

// ── Global error safety net ────────────────────────────────────────────────
// Without these, any unhandled promise rejection or thrown-but-not-caught
// error anywhere in the codebase will terminate the entire Next.js process.
// Logging-and-continue is the right default here: we'd rather see the error
// in the console and keep the server up than have one stray bug take down
// every user's session. uncaughtException is treated more cautiously — Node
// recommends exiting after one because the process state may be corrupt,
// but in practice the supervisor will restart us cleanly if that happens.
process.on('unhandledRejection', (reason) => {
  console.error('[lpos] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[lpos] uncaughtException:', err);
});

async function main() {
  const nextApp = next({ dev, hostname, port });
  const handle  = nextApp.getRequestHandler();

  await nextApp.prepare();

  const requestHandler = async (
    req:  Parameters<typeof handle>[0],
    res:  Parameters<typeof handle>[1],
  ) => {
    const start = Date.now();
    // Intercept writeHead so we can log 5xx responses with route + timing.
    // Helps diagnose 502/503 errors that have no other log trail.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origWriteHead = res.writeHead.bind(res) as (...a: any[]) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).writeHead = (statusCode: number, ...args: any[]) => {
      if (statusCode >= 500) {
        const elapsed = Date.now() - start;
        console.warn(`[lpos] ${statusCode} ${req.method ?? '?'} ${req.url ?? '?'} (${elapsed}ms)`);
      }
      return origWriteHead(statusCode, ...args);
    };
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

  // ── Port conflict guard ────────────────────────────────────────────────────
  // Without this, EADDRINUSE becomes an uncaughtException that we log-and-
  // continue, leaving the process alive with no HTTP server bound — an
  // invisible zombie that still runs all background services and fights with
  // the real server over SQLite and the ATEM bridge.
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[lpos] port ${port} is already in use — another server instance may be running. Exiting.`);
      process.exit(1);
    }
    // Re-throw anything else so it surfaces normally.
    throw err;
  });

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

  // ── Listen ─────────────────────────────────────────────────────────────────
  // Bind the port BEFORE initServices() so we claim it immediately.
  // initServices() can take 30+ seconds (Drive scan, etc.) and any external
  // process manager that health-checks port 3000 would otherwise spawn a
  // second server instance, causing an EADDRINUSE crash loop.

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.log(`  ▲ LPOS  http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}  (services initialising…)`);

  // ── Services ───────────────────────────────────────────────────────────────

  await initServices(io);

  {
    const services = getRegistry()
      .list()
      .map((s) => `${s.name} (${s.status})`)
      .join('  ·  ');
    console.log(`  ↳ ${services}`);
    console.log('');
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      process.stdout.write(`\n[lpos] shutting down (${signal})...\n`);
      // Release port 3000 immediately so the Electron console can spawn a
      // new server without hitting EADDRINUSE while we run service cleanup
      // (which can take 30+ seconds if a backup is in progress).
      httpServer.closeAllConnections?.();
      httpServer.close();
      const code = (globalThis as Record<string, unknown>).__lpos_exitCode as number | undefined;
      await stopServices();
      process.stdout.write('[lpos] goodbye\n');
      process.exit(code ?? 0);
    });
  }
}

main().catch((err) => {
  console.error('[lpos] failed to start:', err);
  process.exit(1);
});
