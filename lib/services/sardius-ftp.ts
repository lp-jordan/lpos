import * as ftp from 'basic-ftp';
import { Readable, PassThrough } from 'node:stream';
import fs from 'node:fs';

function getSardiusConfig() {
  return {
    host:     process.env.SARDIUS_FTP_HOST?.trim() ?? '',
    user:     process.env.SARDIUS_FTP_USER?.trim() ?? '',
    password: process.env.SARDIUS_FTP_PASS?.trim() ?? '',
  };
}

export function isSardiusConfigured(): boolean {
  const { host, user, password } = getSardiusConfig();
  return Boolean(host && user && password);
}

async function createFtpClient(): Promise<ftp.Client> {
  const { host, user, password } = getSardiusConfig();
  if (!host || !user || !password) throw new Error('Sardius FTP credentials not configured.');
  const client = new ftp.Client();
  client.ftp.verbose = false;
  await client.access({ host, user, password, secure: false });
  return client;
}

export interface SardiusFolder {
  name: string;
  path: string;
  children: SardiusFolder[];
}

export async function listSardiusFolders(atPath = '/'): Promise<SardiusFolder[]> {
  const client = await createFtpClient();
  try {
    const entries = await client.list(atPath);
    const base = atPath.replace(/\/$/, '');
    return entries
      .filter((f) => f.isDirectory)
      .map((f) => ({ name: f.name, path: `${base}/${f.name}`, children: [] }));
  } finally {
    client.close();
  }
}

export interface SardiusFolderMetadata {
  speakers: string[];
  categories: string[];
  publishProfile: string;
}

export async function readSardiusFolderJson(folderPath: string): Promise<SardiusFolderMetadata | null> {
  const client = await createFtpClient();
  try {
    const entries = await client.list(folderPath);
    const jsonFile = entries.find((f) => !f.isDirectory && f.name.endsWith('.json'));
    if (!jsonFile) return null;

    const chunks: Buffer[] = [];
    const dest = new PassThrough();
    dest.on('data', (chunk: Buffer) => chunks.push(chunk));

    const remotePath = `${folderPath.replace(/\/$/, '')}/${jsonFile.name}`;
    await client.downloadTo(dest, remotePath);
    dest.end();

    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(raw) as Partial<SardiusFolderMetadata>;
    return {
      speakers:       Array.isArray(parsed.speakers) ? parsed.speakers : [],
      categories:     Array.isArray(parsed.categories) ? parsed.categories : [],
      publishProfile: typeof parsed.publishProfile === 'string' ? parsed.publishProfile : 'hls-enhanced',
    };
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export async function checkSardiusFileExists(folderPath: string, filename: string): Promise<boolean> {
  const client = await createFtpClient();
  try {
    const entries = await client.list(folderPath);
    const lower = filename.toLowerCase();
    return entries.some((f) => !f.isDirectory && f.name.toLowerCase() === lower);
  } catch {
    return false;
  } finally {
    client.close();
  }
}

export async function createSardiusFolder(folderPath: string): Promise<void> {
  const client = await createFtpClient();
  try {
    await client.ensureDir(folderPath);
  } finally {
    client.close();
  }
}

export interface SardiusMetadata {
  speakers: string[];
  categories: string[];
  publishProfile: string;
}

export async function uploadToSardius(
  localFilePath: string,
  remoteDir: string,
  filename: string,
  metadata: SardiusMetadata,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const fileSize = fs.statSync(localFilePath).size;
  const client = await createFtpClient();
  try {
    await client.ensureDir(remoteDir);

    const baseName = filename.replace(/\.[^.]+$/, '');
    const remoteFilePath = `${remoteDir.replace(/\/$/, '')}/${filename}`;
    const remoteJsonPath = `${remoteDir.replace(/\/$/, '')}/${baseName}.json`;

    if (onProgress && fileSize > 0) {
      client.trackProgress((info) => {
        // Reserve the last 2% for the JSON sidecar upload
        const pct = Math.min(98, Math.round((info.bytes / fileSize) * 98));
        onProgress(pct);
      });
    }

    await client.uploadFrom(localFilePath, remoteFilePath);
    client.trackProgress();

    const sidecarJson = JSON.stringify(metadata, null, 2);
    await client.uploadFrom(Readable.from([sidecarJson]), remoteJsonPath);

    onProgress?.(100);
  } finally {
    client.trackProgress();
    client.close();
  }
}
