import { NextRequest, NextResponse } from 'next/server';
import { removePhotos, setPhotosEdited } from '@/lib/store/photo-registry';
import { deletePhotoFiles } from '@/lib/services/photo-image-service';

type Ctx = { params: Promise<{ projectId: string }> };

interface BatchBody {
  action: 'set-edited' | 'delete';
  photoIds: string[];
  edited?: boolean;
}

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const body = await req.json() as BatchBody;

    if (!Array.isArray(body.photoIds) || body.photoIds.length === 0) {
      return NextResponse.json({ error: 'photoIds (non-empty array) is required' }, { status: 400 });
    }

    if (body.action === 'set-edited') {
      if (typeof body.edited !== 'boolean') {
        return NextResponse.json({ error: 'edited (boolean) is required for set-edited' }, { status: 400 });
      }
      const updated = setPhotosEdited(projectId, body.photoIds, body.edited);
      return NextResponse.json({ updated });
    }

    if (body.action === 'delete') {
      const removed = removePhotos(projectId, body.photoIds);
      for (const photo of removed) {
        deletePhotoFiles(projectId, photo.photoId, photo.filePath);
      }
      return NextResponse.json({ deleted: removed.length });
    }

    return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
