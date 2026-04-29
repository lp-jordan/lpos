import { NextRequest, NextResponse } from 'next/server';
import { isSardiusConfigured, listSardiusFolders, createSardiusFolder, readSardiusFolderJson } from '@/lib/services/sardius-ftp';

function notConfigured() {
  return NextResponse.json(
    { error: 'Sardius FTP credentials are not configured on this LPOS host.' },
    { status: 501 },
  );
}

export async function GET(req: NextRequest) {
  if (!isSardiusConfigured()) return notConfigured();
  const path = req.nextUrl.searchParams.get('path') ?? '/';
  try {
    const [folders, folderMetadata] = await Promise.all([
      listSardiusFolders(path),
      path !== '/' ? readSardiusFolderJson(path) : Promise.resolve(null),
    ]);
    return NextResponse.json({ folders, folderMetadata });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sardius] folder listing failed:', message);
    return NextResponse.json({ error: `FTP error: ${message}` }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!isSardiusConfigured()) return notConfigured();
  const body = await req.json() as { path?: string };
  if (!body.path?.trim()) {
    return NextResponse.json({ error: 'path is required.' }, { status: 400 });
  }
  try {
    await createSardiusFolder(body.path.trim());
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sardius] folder creation failed:', message);
    return NextResponse.json({ error: `FTP error: ${message}` }, { status: 502 });
  }
}
