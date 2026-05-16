export interface PhotoAsset {
  photoId: string;
  projectId: string;
  originalFilename: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  /** EXIF DateTimeOriginal (or DateTime fallback) parsed at upload time. Null when EXIF is absent or unparseable. */
  captureDate: string | null;
  uploadedAt: string;
  updatedAt: string;
  edited: boolean;
}

export const PHOTO_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/x-adobe-dng',
  'image/x-sony-arw',
]);

export const PHOTO_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
  '.heic', '.heif', '.tif', '.tiff', '.dng', '.arw',
]);

export function guessPhotoMime(filename: string): string {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  switch (ext) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png':  return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif':  return 'image/gif';
    case '.heic': return 'image/heic';
    case '.heif': return 'image/heif';
    case '.tif':
    case '.tiff': return 'image/tiff';
    case '.dng':  return 'image/x-adobe-dng';
    case '.arw':  return 'image/x-sony-arw';
    default:      return 'application/octet-stream';
  }
}
