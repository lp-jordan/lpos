import type { NextRequest } from 'next/server';

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function getAppOrigin(req?: NextRequest): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return trimTrailingSlash(configured);

  if (req) {
    const forwardedProto = req.headers.get('x-forwarded-proto');
    const forwardedHost = req.headers.get('x-forwarded-host');
    if (forwardedProto && forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`;
    }

    const host = req.headers.get('host');
    if (host) {
      const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1')
        ? 'http'
        : 'https';
      return `${protocol}://${host}`;
    }

    if (req.nextUrl.origin) {
      return trimTrailingSlash(req.nextUrl.origin);
    }
  }

  return 'https://localhost:3000';
}

export function buildAppUrl(pathname: string, req?: NextRequest): URL {
  return new URL(pathname, `${getAppOrigin(req)}/`);
}
