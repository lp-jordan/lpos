/**
 * GET /api/debug/frameio
 *
 * Diagnostic endpoint — probes Frame.io V4 API endpoints to verify
 * the OAuth token works and the account structure is visible.
 */

import { NextResponse } from 'next/server';
import { isConnected, getValidAccessToken } from '@/lib/services/frameio-tokens';

const BASE_V4 = 'https://api.frame.io/v4';

async function probe(label: string, url: string, method = 'GET', body?: unknown) {
  try {
    const token    = await getValidAccessToken();
    const clientId = process.env.FRAMEIO_CLIENT_ID?.trim() ?? '';
    const res = await fetch(url, {
      method,
      headers: {
        Authorization:  `Bearer ${token}`,
        'x-api-key':    clientId,
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = text; }
    return { label, url, status: res.status, ok: res.ok, data: json };
  } catch (err) {
    return { label, url, status: 0, ok: false, error: (err as Error).message };
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts   = token.split('.');
    if (parts.length < 2) return {};
    const padded  = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function GET() {
  if (!isConnected()) {
    return NextResponse.json({
      connected: false,
      message:   'Frame.io not connected. Visit /api/auth/frameio/connect first.',
    }, { status: 401 });
  }

  const token   = await getValidAccessToken();
  const claims  = decodeJwtPayload(token);
  const results: Record<string, unknown>[] = [];

  const clientId = process.env.FRAMEIO_CLIENT_ID?.trim() ?? '';

  // Always probe these regardless of account_id
  results.push(await probe('V4 /me',       `${BASE_V4}/me`));
  results.push(await probe('V4 /accounts', `${BASE_V4}/accounts`));
  results.push(await probe('v2 /me (legacy auth)', 'https://api.frame.io/v2/me'));

  // Extract account_id candidates
  const v4meData     = results[0].data as Record<string, unknown> | undefined;
  const v4accounts   = results[1].data as { data?: { id: string }[] } | { id: string }[] | undefined;
  const v2meData     = results[2].data as Record<string, unknown> | undefined;

  function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
  const v4meInner = (v4meData?.data ?? v4meData) as Record<string, unknown> | undefined;
  const v4acctList: { id?: string }[] = Array.isArray(v4accounts)
    ? v4accounts
    : ((v4accounts as { data?: { id: string }[] } | undefined)?.data ?? []);

  const accountId: string =
    str(claims.account_id) ||
    str(claims.frameio_account_id) ||
    str(v4meInner?.account_id) ||
    str(v2meData?.account_id) ||
    str(v4acctList[0]?.id) ||
    '';

  if (accountId) {
    results.push(await probe(`V4 account details (plan/limits)`, `${BASE_V4}/accounts/${accountId}`));
    results.push(await probe(`V4 workspaces (account ${accountId})`, `${BASE_V4}/accounts/${accountId}/workspaces`));

    const wsProbe = results.at(-1);
    const wsData  = wsProbe?.data as { data?: { id: string; name: string }[] } | { id: string }[] | undefined;
    const workspaces: { id: string; name?: string }[] = Array.isArray(wsData)
      ? wsData
      : ((wsData as { data?: { id: string }[] })?.data ?? []);

    for (const ws of workspaces.slice(0, 3)) {
      results.push(
        await probe(
          `Projects in workspace "${ws.name ?? ws.id}"`,
          `${BASE_V4}/accounts/${accountId}/workspaces/${ws.id}/projects`,
        ),
      );
    }

    // Probe folder-scoped endpoints (the ones we're now trying for upload)
    const lposRootFolderId = '9439b5d3-5fad-4a0f-9085-602b572b0ee2';
    results.push(await probe('GET  folder/items',    `${BASE_V4}/accounts/${accountId}/folders/${lposRootFolderId}/items`));
    results.push(await probe('GET  folder/files',    `${BASE_V4}/accounts/${accountId}/folders/${lposRootFolderId}/files`));
    results.push(await probe('GET  folder/folders',  `${BASE_V4}/accounts/${accountId}/folders/${lposRootFolderId}/folders`));
    results.push(await probe('GET  folder (bare)',   `${BASE_V4}/accounts/${accountId}/folders/${lposRootFolderId}`));
    results.push(await probe('GET  project/files',   `${BASE_V4}/accounts/${accountId}/projects/0f27e244-3011-4e81-90f1-1b44cfa9c596/files`));
    results.push(await probe('HEAD folder/files',    `${BASE_V4}/accounts/${accountId}/folders/${lposRootFolderId}/files`, 'HEAD'));
  }

  return NextResponse.json({
    connected:    true,
    accountId:    accountId || '(could not determine)',
    jwtClaims:    { keys: Object.keys(claims), values: claims },
    clientId,
    results,
  });
}
