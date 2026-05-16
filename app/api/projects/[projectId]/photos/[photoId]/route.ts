import { NextRequest, NextResponse } from 'next/server';
import { getPhoto, removePhoto, setPhotoEdited } from '@/lib/store/photo-registry';
import { deletePhotoFiles } from '@/lib/services/photo-image-service';

type Ctx = { params: Promise<{ projectId: string; photoId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, photoId } = await params;
  const photo = getPhoto(projectId, photoId);
  if (!photo) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ photo });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, photoId } = await params;
    const body = await req.json() as { edited?: boolean };
    if (typeof body.edited !== 'boolean') {
      return NextResponse.json({ error: 'edited (boolean) is required' }, { status: 400 });
    }
    const updated = setPhotoEdited(projectId, photoId, body.edited);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ photo: updated });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, photoId } = await params;
    const removed = removePhoto(projectId, photoId);
    if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    deletePhotoFiles(projectId, photoId, removed.filePath);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
