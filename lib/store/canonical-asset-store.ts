import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getCanonicalAssetDb } from '@/lib/store/canonical-asset-db';
import type {
  CanonicalAsset,
  CanonicalAssetVersion,
  CanonicalDistributionProvider,
  CanonicalDistributionRecord,
  CanonicalMediaFile,
  CanonicalTranscriptionJob,
} from '@/lib/models/canonical-asset';
import type {
  CloudflareStreamInfo,
  FrameIOInfo,
  LeaderPassInfo,
  MediaAsset,
  StorageType,
  TranscriptionInfo,
} from '@/lib/models/media-asset';
import {
  defaultCloudflareStream,
  defaultFrameIO,
  defaultLeaderPass,
  defaultTranscription,
} from '@/lib/models/media-asset';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

export interface CanonicalRegisterInput {
  projectId: string;
  assetId?: string;
  name?: string;
  description?: string;
  tags?: string[];
  originalFilename: string;
  filePath: string | null;
  fileSize: number | null;
  mimeType?: string | null;
  storageType: StorageType;
  existingAssetId?: string;
}

export interface CanonicalAssetPatch {
  name?: string;
  description?: string;
  tags?: string[];
  filePath?: string | null;
  fileSize?: number | null;
  transcription?: Partial<TranscriptionInfo>;
  frameio?: Partial<FrameIOInfo>;
  cloudflare?: Partial<CloudflareStreamInfo>;
  leaderpass?: Partial<LeaderPassInfo>;
}

type AssetRow = Row & CanonicalAsset;
type VersionRow = Row & CanonicalAssetVersion;
type MediaFileRow = Row & CanonicalMediaFile;
type DistributionRow = Row & CanonicalDistributionRecord;
type TranscriptionRow = Row & CanonicalTranscriptionJob;
type Row = Record<string, unknown>;
type SqlParams = Record<string, string | number | null>;

type AssetBundle = {
  asset: AssetRow;
  versions: VersionRow[];
  mediaFiles: MediaFileRow[];
  distributions: DistributionRow[];
  transcriptions: TranscriptionRow[];
};

export interface CanonicalVersionCandidate {
  asset: MediaAsset;
  duplicate: boolean;
  currentVersionNumber: number;
  incomingLabel: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function legacyRegistryPath(projectId: string): string {
  return path.join(DATA_DIR, 'projects', projectId, 'media-registry.json');
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function normalizeAssetKey(name: string): string {
  return stripExtension(name)
    .trim()
    .toUpperCase()
    .replace(/[_\s-]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '');
}

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function parseMetadataJson<T>(metadataJson: string | null | undefined): Partial<T> {
  if (!metadataJson) return {};
  try {
    return JSON.parse(metadataJson) as Partial<T>;
  } catch {
    return {};
  }
}

function getStorageClass(storageType: StorageType): CanonicalMediaFile['storage_class'] {
  return storageType === 'uploaded' ? 'local_upload' : 'nas';
}

function getStorageType(storageClass: string): StorageType {
  return storageClass === 'local_upload' ? 'uploaded' : 'registered';
}

function pickOperationalPath(mediaFile: MediaFileRow | null): string | null {
  if (!mediaFile) return null;
  return mediaFile.managed_path ?? mediaFile.source_path ?? null;
}

function pickLatestVersion(versions: VersionRow[]): VersionRow | null {
  if (!versions.length) return null;
  const nonDuplicate = versions.find((version) => version.status !== 'duplicate');
  return nonDuplicate ?? versions[0] ?? null;
}

function pickPrimaryMediaFile(bundle: AssetBundle, assetVersionId: string | null): MediaFileRow | null {
  if (!assetVersionId) return null;
  return bundle.mediaFiles.find((file) => file.asset_version_id === assetVersionId && file.role === 'primary')
    ?? bundle.mediaFiles.find((file) => file.asset_version_id === assetVersionId)
    ?? null;
}

function pickLatestDistribution(
  bundle: AssetBundle,
  assetVersionId: string | null,
  provider: CanonicalDistributionProvider,
): DistributionRow | null {
  if (!assetVersionId) return null;
  return bundle.distributions.find(
    (distribution) => distribution.asset_version_id === assetVersionId && distribution.provider === provider,
  ) ?? null;
}

function pickLatestTranscription(bundle: AssetBundle, assetVersionId: string | null): TranscriptionRow | null {
  if (!assetVersionId) return null;
  return bundle.transcriptions.find((transcription) => transcription.asset_version_id === assetVersionId) ?? null;
}

function computeFileHashSync(filePath: string | null): string | null {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }

  return `sha256:${hash.digest('hex')}`;
}

function sourceModifiedAt(filePath: string | null): string | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function assetExists(projectId: string): boolean {
  const db = getCanonicalAssetDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM assets WHERE project_id = ?',
  ).get(projectId) as Row & { count: number };
  return row.count > 0;
}

function readLegacyAssets(projectId: string): MediaAsset[] {
  const registryPath = legacyRegistryPath(projectId);
  if (!fs.existsSync(registryPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8')) as MediaAsset[];
  } catch {
    return [];
  }
}

function rowToAssetBundle(assetId: string): AssetBundle | null {
  const db = getCanonicalAssetDb();
  const asset = db.prepare('SELECT * FROM assets WHERE asset_id = ?').get(assetId) as AssetRow | undefined;
  if (!asset) return null;

  const versions = db.prepare(
    'SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY version_number DESC, created_at DESC',
  ).all(assetId) as VersionRow[];
  const versionIds = versions.map((version) => version.asset_version_id);
  const mediaFiles = versionIds.length
    ? db.prepare(
      `SELECT * FROM media_files WHERE asset_version_id IN (${versionIds.map(() => '?').join(', ')})
       ORDER BY created_at DESC`,
    ).all(...versionIds) as MediaFileRow[]
    : [];
  const distributions = versionIds.length
    ? db.prepare(
      `SELECT * FROM distribution_records WHERE asset_version_id IN (${versionIds.map(() => '?').join(', ')})
       ORDER BY attempt_number DESC, updated_at DESC, created_at DESC`,
    ).all(...versionIds) as DistributionRow[]
    : [];
  const transcriptions = versionIds.length
    ? db.prepare(
      `SELECT * FROM transcription_jobs WHERE asset_version_id IN (${versionIds.map(() => '?').join(', ')})
       ORDER BY updated_at DESC, created_at DESC`,
    ).all(...versionIds) as TranscriptionRow[]
    : [];

  return { asset, versions, mediaFiles, distributions, transcriptions };
}

function bundleToProjection(bundle: AssetBundle): MediaAsset {
  const currentVersion = pickLatestVersion(bundle.versions);
  const currentVersionId = currentVersion?.asset_version_id ?? null;
  const mediaFile = pickPrimaryMediaFile(bundle, currentVersionId);
  const frameio = pickLatestDistribution(bundle, currentVersionId, 'frameio');
  const cloudflare = pickLatestDistribution(bundle, currentVersionId, 'cloudflare');
  const leaderpass = pickLatestDistribution(bundle, currentVersionId, 'leaderpass');
  const transcription = pickLatestTranscription(bundle, currentVersionId);
  const frameioMeta = parseMetadataJson<FrameIOInfo>(frameio?.metadata_json);
  const cloudflareMeta = parseMetadataJson<CloudflareStreamInfo>(cloudflare?.metadata_json);
  const leaderpassMeta = parseMetadataJson<LeaderPassInfo>(leaderpass?.metadata_json);
  const transcriptionMeta = parseMetadataJson<TranscriptionInfo>(transcription?.metadata_json);

  return {
    assetId: bundle.asset.asset_id,
    projectId: bundle.asset.project_id,
    name: bundle.asset.current_display_name,
    description: bundle.asset.description,
    tags: parseTags(bundle.asset.tags_json),
    originalFilename: mediaFile?.original_filename ?? bundle.asset.current_display_name,
    filePath: pickOperationalPath(mediaFile),
    fileSize: mediaFile?.file_size_bytes ?? null,
    mimeType: mediaFile?.mime_type ?? null,
    storageType: getStorageType(mediaFile?.storage_class ?? 'nas'),
    registeredAt: bundle.asset.created_at,
    updatedAt: bundle.asset.updated_at,
    transcription: {
      ...defaultTranscription(),
      ...transcriptionMeta,
      status: (transcription?.status as TranscriptionInfo['status']) ?? transcriptionMeta.status ?? 'none',
      jobId: transcription?.job_id ?? transcriptionMeta.jobId ?? null,
      completedAt: transcription?.completed_at ?? transcriptionMeta.completedAt ?? null,
    },
    frameio: {
      ...defaultFrameIO(),
      ...frameioMeta,
      assetId: frameio?.provider_asset_id ?? frameioMeta.assetId ?? null,
      reviewLink: frameio?.review_url ?? frameioMeta.reviewLink ?? null,
      playerUrl: frameio?.playback_url ?? frameioMeta.playerUrl ?? null,
      status: (frameio?.provider_status as FrameIOInfo['status']) ?? frameioMeta.status ?? 'none',
      version: currentVersion?.version_number ?? frameioMeta.version ?? 1,
      uploadedAt: frameio?.published_at ?? frameioMeta.uploadedAt ?? null,
      lastError: frameio?.last_error ?? frameioMeta.lastError ?? null,
    },
    cloudflare: {
      ...defaultCloudflareStream(),
      ...cloudflareMeta,
      uid: cloudflare?.provider_asset_id ?? cloudflareMeta.uid ?? null,
      previewUrl: cloudflare?.playback_url ?? cloudflareMeta.previewUrl ?? null,
      thumbnailUrl: cloudflare?.thumbnail_url ?? cloudflareMeta.thumbnailUrl ?? null,
      status: (cloudflare?.provider_status as CloudflareStreamInfo['status']) ?? cloudflareMeta.status ?? 'none',
      readyAt: cloudflare?.ready_at ?? cloudflareMeta.readyAt ?? null,
      uploadedAt: cloudflare?.published_at ?? cloudflareMeta.uploadedAt ?? null,
      lastError: cloudflare?.last_error ?? cloudflareMeta.lastError ?? null,
    },
    leaderpass: {
      ...defaultLeaderPass(),
      ...leaderpassMeta,
      status: (leaderpass?.provider_status as LeaderPassInfo['status']) ?? leaderpassMeta.status ?? 'none',
      contentId: leaderpass?.provider_asset_id ?? leaderpassMeta.contentId ?? null,
      tileId: leaderpass?.provider_parent_id ?? leaderpassMeta.tileId ?? null,
      playbackUrl: leaderpass?.playback_url ?? leaderpassMeta.playbackUrl ?? null,
      thumbnailUrl: leaderpass?.thumbnail_url ?? leaderpassMeta.thumbnailUrl ?? null,
      publishedAt: leaderpass?.published_at ?? leaderpassMeta.publishedAt ?? null,
      lastError: leaderpass?.last_error ?? leaderpassMeta.lastError ?? null,
    },
  };
}

function insertAsset(asset: CanonicalAsset): void {
  const db = getCanonicalAssetDb();
  db.prepare(`
    INSERT INTO assets (
      asset_id, project_id, client_code, display_label, current_display_name, description, tags_json,
      status, source_system, created_at, updated_at, archived_at, migration_source, migrated_at
    ) VALUES (
      @asset_id, @project_id, @client_code, @display_label, @current_display_name, @description, @tags_json,
      @status, @source_system, @created_at, @updated_at, @archived_at, @migration_source, @migrated_at
    )
  `).run(asset as unknown as SqlParams);
}

function insertVersion(version: CanonicalAssetVersion): void {
  const db = getCanonicalAssetDb();
  db.prepare(`
    INSERT INTO asset_versions (
      asset_version_id, asset_id, version_number, version_label, ingest_mode, status, exported_at, ingested_at,
      export_preset, edit_label_at_export, source_event_id, replaced_by_version_id, supersedes_version_id,
      created_at, updated_at
    ) VALUES (
      @asset_version_id, @asset_id, @version_number, @version_label, @ingest_mode, @status, @exported_at, @ingested_at,
      @export_preset, @edit_label_at_export, @source_event_id, @replaced_by_version_id, @supersedes_version_id,
      @created_at, @updated_at
    )
  `).run(version as unknown as SqlParams);
}

function insertMediaFile(mediaFile: CanonicalMediaFile): void {
  const db = getCanonicalAssetDb();
  db.prepare(`
    INSERT INTO media_files (
      media_file_id, asset_version_id, role, source_path, managed_path, storage_class, original_filename,
      managed_filename, mime_type, file_size_bytes, content_hash, source_modified_at, copied_to_managed_at,
      is_source_available, is_managed_available, displacement_status, created_at, updated_at
    ) VALUES (
      @media_file_id, @asset_version_id, @role, @source_path, @managed_path, @storage_class, @original_filename,
      @managed_filename, @mime_type, @file_size_bytes, @content_hash, @source_modified_at, @copied_to_managed_at,
      @is_source_available, @is_managed_available, @displacement_status, @created_at, @updated_at
    )
  `).run(mediaFile as unknown as SqlParams);
}

function insertDistribution(distribution: CanonicalDistributionRecord): void {
  const db = getCanonicalAssetDb();
  db.prepare(`
    INSERT INTO distribution_records (
      distribution_record_id, asset_version_id, provider, provider_status, provider_asset_id, provider_parent_id,
      attempt_number, published_at, ready_at, last_error, playback_url, review_url, thumbnail_url, metadata_json,
      created_at, updated_at
    ) VALUES (
      @distribution_record_id, @asset_version_id, @provider, @provider_status, @provider_asset_id, @provider_parent_id,
      @attempt_number, @published_at, @ready_at, @last_error, @playback_url, @review_url, @thumbnail_url, @metadata_json,
      @created_at, @updated_at
    )
  `).run(distribution as unknown as SqlParams);
}

function insertTranscription(transcription: CanonicalTranscriptionJob): void {
  const db = getCanonicalAssetDb();
  db.prepare(`
    INSERT INTO transcription_jobs (
      transcription_job_id, asset_version_id, status, job_id, provider, completed_at, last_error, metadata_json,
      created_at, updated_at
    ) VALUES (
      @transcription_job_id, @asset_version_id, @status, @job_id, @provider, @completed_at, @last_error, @metadata_json,
      @created_at, @updated_at
    )
  `).run(transcription as unknown as SqlParams);
}

function importLegacyAsset(projectId: string, legacyAsset: MediaAsset): void {
  const db = getCanonicalAssetDb();
  const existing = db.prepare('SELECT asset_id FROM assets WHERE asset_id = ?').get(legacyAsset.assetId) as Row | undefined;
  if (existing) return;

  const createdAt = legacyAsset.registeredAt || nowIso();
  const updatedAt = legacyAsset.updatedAt || createdAt;
  const versionId = randomUUID();

  insertAsset({
    asset_id: legacyAsset.assetId,
    project_id: projectId,
    client_code: null,
    display_label: null,
    current_display_name: legacyAsset.name,
    description: legacyAsset.description ?? '',
    tags_json: JSON.stringify(legacyAsset.tags ?? []),
    status: 'active',
    source_system: 'legacy_media_registry',
    created_at: createdAt,
    updated_at: updatedAt,
    archived_at: null,
    migration_source: 'media-registry.json',
    migrated_at: nowIso(),
  });

  insertVersion({
    asset_version_id: versionId,
    asset_id: legacyAsset.assetId,
    version_number: 1,
    version_label: null,
    ingest_mode: legacyAsset.storageType === 'uploaded' ? 'manual' : 'observed',
    status: 'ready',
    exported_at: null,
    ingested_at: createdAt,
    export_preset: null,
    edit_label_at_export: null,
    source_event_id: null,
    replaced_by_version_id: null,
    supersedes_version_id: null,
    created_at: createdAt,
    updated_at: updatedAt,
  });

  insertMediaFile({
    media_file_id: randomUUID(),
    asset_version_id: versionId,
    role: 'primary',
    source_path: legacyAsset.filePath,
    managed_path: legacyAsset.filePath,
    storage_class: getStorageClass(legacyAsset.storageType),
    original_filename: legacyAsset.originalFilename,
    managed_filename: legacyAsset.filePath ? path.basename(legacyAsset.filePath) : null,
    mime_type: legacyAsset.mimeType,
    file_size_bytes: legacyAsset.fileSize,
    content_hash: computeFileHashSync(legacyAsset.filePath),
    source_modified_at: sourceModifiedAt(legacyAsset.filePath),
    copied_to_managed_at: legacyAsset.filePath ? createdAt : null,
    is_source_available: legacyAsset.filePath && fs.existsSync(legacyAsset.filePath) ? 1 : 0,
    is_managed_available: legacyAsset.filePath && fs.existsSync(legacyAsset.filePath) ? 1 : 0,
    displacement_status: 'normal',
    created_at: createdAt,
    updated_at: updatedAt,
  });

  if (legacyAsset.frameio.assetId || legacyAsset.frameio.reviewLink || legacyAsset.frameio.playerUrl || legacyAsset.frameio.lastError) {
    insertDistribution({
      distribution_record_id: randomUUID(),
      asset_version_id: versionId,
      provider: 'frameio',
      provider_status: legacyAsset.frameio.status,
      provider_asset_id: legacyAsset.frameio.assetId,
      provider_parent_id: null,
      attempt_number: 1,
      published_at: legacyAsset.frameio.uploadedAt,
      ready_at: null,
      last_error: legacyAsset.frameio.lastError,
      playback_url: legacyAsset.frameio.playerUrl,
      review_url: legacyAsset.frameio.reviewLink,
      thumbnail_url: null,
      metadata_json: JSON.stringify(legacyAsset.frameio),
      created_at: legacyAsset.frameio.uploadedAt ?? createdAt,
      updated_at: updatedAt,
    });
  }

  if (legacyAsset.cloudflare.uid || legacyAsset.cloudflare.previewUrl || legacyAsset.cloudflare.lastError) {
    insertDistribution({
      distribution_record_id: randomUUID(),
      asset_version_id: versionId,
      provider: 'cloudflare',
      provider_status: legacyAsset.cloudflare.status,
      provider_asset_id: legacyAsset.cloudflare.uid,
      provider_parent_id: null,
      attempt_number: 1,
      published_at: legacyAsset.cloudflare.uploadedAt,
      ready_at: legacyAsset.cloudflare.readyAt,
      last_error: legacyAsset.cloudflare.lastError,
      playback_url: legacyAsset.cloudflare.previewUrl,
      review_url: null,
      thumbnail_url: legacyAsset.cloudflare.thumbnailUrl,
      metadata_json: JSON.stringify(legacyAsset.cloudflare),
      created_at: legacyAsset.cloudflare.uploadedAt ?? createdAt,
      updated_at: updatedAt,
    });
  }

  if (legacyAsset.leaderpass.contentId || legacyAsset.leaderpass.playbackUrl || legacyAsset.leaderpass.lastError) {
    insertDistribution({
      distribution_record_id: randomUUID(),
      asset_version_id: versionId,
      provider: 'leaderpass',
      provider_status: legacyAsset.leaderpass.status,
      provider_asset_id: legacyAsset.leaderpass.contentId,
      provider_parent_id: legacyAsset.leaderpass.tileId,
      attempt_number: 1,
      published_at: legacyAsset.leaderpass.publishedAt,
      ready_at: null,
      last_error: legacyAsset.leaderpass.lastError,
      playback_url: legacyAsset.leaderpass.playbackUrl,
      review_url: null,
      thumbnail_url: legacyAsset.leaderpass.thumbnailUrl,
      metadata_json: JSON.stringify(legacyAsset.leaderpass),
      created_at: legacyAsset.leaderpass.lastPreparedAt ?? createdAt,
      updated_at: updatedAt,
    });
  }

  if (legacyAsset.transcription.status !== 'none' || legacyAsset.transcription.jobId || legacyAsset.transcription.completedAt) {
    insertTranscription({
      transcription_job_id: randomUUID(),
      asset_version_id: versionId,
      status: legacyAsset.transcription.status,
      job_id: legacyAsset.transcription.jobId,
      provider: 'transcripter',
      completed_at: legacyAsset.transcription.completedAt,
      last_error: legacyAsset.transcription.status === 'failed' ? 'Legacy transcription migrated without detailed error' : null,
      metadata_json: JSON.stringify(legacyAsset.transcription),
      created_at: createdAt,
      updated_at: updatedAt,
    });
  }
}

function ensureProjectMigrated(projectId: string): void {
  if (assetExists(projectId)) return;
  const legacyAssets = readLegacyAssets(projectId);
  if (!legacyAssets.length) return;
  for (const legacyAsset of legacyAssets) {
    importLegacyAsset(projectId, legacyAsset);
  }
}

function getLatestVersionForAsset(assetId: string): VersionRow | null {
  const db = getCanonicalAssetDb();
  return db.prepare(
    'SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY version_number DESC, created_at DESC LIMIT 1',
  ).get(assetId) as VersionRow | null;
}

function getLatestNonDuplicateVersionForAsset(assetId: string): VersionRow | null {
  const db = getCanonicalAssetDb();
  return db.prepare(
    `SELECT * FROM asset_versions
     WHERE asset_id = ? AND status != 'duplicate'
     ORDER BY version_number DESC, created_at DESC LIMIT 1`,
  ).get(assetId) as VersionRow | null;
}

function getPrimaryMediaFileForVersion(assetVersionId: string): MediaFileRow | null {
  const db = getCanonicalAssetDb();
  return db.prepare(
    `SELECT * FROM media_files
     WHERE asset_version_id = ?
     ORDER BY CASE WHEN role = 'primary' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
  ).get(assetVersionId) as MediaFileRow | null;
}

function upsertAssetFields(assetId: string, patch: CanonicalAssetPatch): void {
  const db = getCanonicalAssetDb();
  const current = db.prepare('SELECT * FROM assets WHERE asset_id = ?').get(assetId) as AssetRow | undefined;
  if (!current) return;

  db.prepare(`
    UPDATE assets
    SET current_display_name = ?,
        description = ?,
        tags_json = ?,
        updated_at = ?
    WHERE asset_id = ?
  `).run(
    patch.name ?? current.current_display_name,
    patch.description ?? current.description,
    patch.tags ? JSON.stringify(patch.tags) : current.tags_json,
    nowIso(),
    assetId,
  );
}

function upsertMediaFileFields(assetId: string, patch: CanonicalAssetPatch): void {
  if (patch.filePath === undefined && patch.fileSize === undefined) return;

  const version = getLatestVersionForAsset(assetId);
  if (!version) return;
  const mediaFile = getPrimaryMediaFileForVersion(version.asset_version_id);
  if (!mediaFile) return;

  const db = getCanonicalAssetDb();
  const nextFilePath = patch.filePath !== undefined ? patch.filePath : pickOperationalPath(mediaFile);
  const sourceAvailable = nextFilePath && fs.existsSync(nextFilePath) ? 1 : 0;
  db.prepare(`
    UPDATE media_files
    SET source_path = ?,
        managed_path = ?,
        file_size_bytes = ?,
        managed_filename = ?,
        source_modified_at = ?,
        is_source_available = ?,
        is_managed_available = ?,
        updated_at = ?
    WHERE media_file_id = ?
  `).run(
    nextFilePath,
    nextFilePath,
    patch.fileSize ?? mediaFile.file_size_bytes,
    nextFilePath ? path.basename(nextFilePath) : mediaFile.managed_filename,
    sourceModifiedAt(nextFilePath),
    sourceAvailable,
    sourceAvailable,
    nowIso(),
    mediaFile.media_file_id,
  );
}

function createOrUpdateDistributionRecord(
  assetId: string,
  provider: CanonicalDistributionProvider,
  patch: Record<string, unknown>,
): void {
  const version = getLatestVersionForAsset(assetId);
  if (!version) return;

  const db = getCanonicalAssetDb();
  const latest = db.prepare(
    `SELECT * FROM distribution_records
     WHERE asset_version_id = ? AND provider = ?
     ORDER BY attempt_number DESC, updated_at DESC LIMIT 1`,
  ).get(version.asset_version_id, provider) as DistributionRow | undefined;

  const inProgressStatuses = new Set(['uploading', 'preparing']);
  const requestedStatus = typeof patch.provider_status === 'string' ? patch.provider_status : null;
  const shouldCreateNewAttempt = requestedStatus !== null
    && inProgressStatuses.has(requestedStatus)
    && latest !== undefined
    && (
      latest.provider_asset_id !== null
      || latest.published_at !== null
      || latest.ready_at !== null
      || latest.provider_status === 'failed'
      || latest.provider_status === 'published'
      || latest.provider_status === 'ready'
      || latest.provider_status === 'in_review'
      || latest.provider_status === 'approved'
    );

  const existingMetadata = latest?.metadata_json ? parseMetadataJson<Record<string, unknown>>(latest.metadata_json) : {};
  const mergedMetadata = JSON.stringify({ ...existingMetadata, ...patch });
  const timestamp = nowIso();

  if (!latest || shouldCreateNewAttempt) {
    insertDistribution({
      distribution_record_id: randomUUID(),
      asset_version_id: version.asset_version_id,
      provider,
      provider_status: requestedStatus ?? latest?.provider_status ?? 'none',
      provider_asset_id: typeof patch.provider_asset_id === 'string' ? patch.provider_asset_id : null,
      provider_parent_id: typeof patch.provider_parent_id === 'string' ? patch.provider_parent_id : null,
      attempt_number: (latest?.attempt_number ?? 0) + 1,
      published_at: typeof patch.published_at === 'string' ? patch.published_at : null,
      ready_at: typeof patch.ready_at === 'string' ? patch.ready_at : null,
      last_error: typeof patch.last_error === 'string' ? patch.last_error : null,
      playback_url: typeof patch.playback_url === 'string' ? patch.playback_url : null,
      review_url: typeof patch.review_url === 'string' ? patch.review_url : null,
      thumbnail_url: typeof patch.thumbnail_url === 'string' ? patch.thumbnail_url : null,
      metadata_json: mergedMetadata,
      created_at: timestamp,
      updated_at: timestamp,
    });
    return;
  }

  db.prepare(`
    UPDATE distribution_records
    SET provider_status = ?,
        provider_asset_id = ?,
        provider_parent_id = ?,
        published_at = ?,
        ready_at = ?,
        last_error = ?,
        playback_url = ?,
        review_url = ?,
        thumbnail_url = ?,
        metadata_json = ?,
        updated_at = ?
    WHERE distribution_record_id = ?
  `).run(
    requestedStatus ?? latest.provider_status,
    typeof patch.provider_asset_id === 'string' ? patch.provider_asset_id : latest.provider_asset_id,
    typeof patch.provider_parent_id === 'string' ? patch.provider_parent_id : latest.provider_parent_id,
    typeof patch.published_at === 'string' ? patch.published_at : latest.published_at,
    typeof patch.ready_at === 'string' ? patch.ready_at : latest.ready_at,
    patch.last_error === null ? null : typeof patch.last_error === 'string' ? patch.last_error : latest.last_error,
    typeof patch.playback_url === 'string' ? patch.playback_url : latest.playback_url,
    typeof patch.review_url === 'string' ? patch.review_url : latest.review_url,
    typeof patch.thumbnail_url === 'string' ? patch.thumbnail_url : latest.thumbnail_url,
    mergedMetadata,
    timestamp,
    latest.distribution_record_id,
  );
}

function upsertTranscriptionRecord(assetId: string, patch: Partial<TranscriptionInfo>): void {
  const version = getLatestVersionForAsset(assetId);
  if (!version) return;

  const db = getCanonicalAssetDb();
  const latest = db.prepare(
    `SELECT * FROM transcription_jobs
     WHERE asset_version_id = ?
     ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
  ).get(version.asset_version_id) as TranscriptionRow | undefined;
  const metadata = JSON.stringify({
    ...parseMetadataJson<Record<string, unknown>>(latest?.metadata_json),
    ...patch,
  });
  const timestamp = nowIso();

  if (!latest) {
    insertTranscription({
      transcription_job_id: randomUUID(),
      asset_version_id: version.asset_version_id,
      status: patch.status ?? 'none',
      job_id: patch.jobId ?? null,
      provider: 'transcripter',
      completed_at: patch.completedAt ?? null,
      last_error: patch.status === 'failed' ? 'Transcription failed' : null,
      metadata_json: metadata,
      created_at: timestamp,
      updated_at: timestamp,
    });
    return;
  }

  db.prepare(`
    UPDATE transcription_jobs
    SET status = ?,
        job_id = ?,
        completed_at = ?,
        last_error = ?,
        metadata_json = ?,
        updated_at = ?
    WHERE transcription_job_id = ?
  `).run(
    patch.status ?? latest.status,
    patch.jobId ?? latest.job_id,
    patch.completedAt ?? latest.completed_at,
    patch.status === 'failed' ? 'Transcription failed' : patch.status === 'done' ? null : latest.last_error,
    metadata,
    timestamp,
    latest.transcription_job_id,
  );
}

export function listCanonicalMediaAssets(projectId: string): MediaAsset[] {
  ensureProjectMigrated(projectId);
  const db = getCanonicalAssetDb();
  const assets = db.prepare(
    'SELECT asset_id FROM assets WHERE project_id = ? ORDER BY created_at ASC',
  ).all(projectId) as Array<Row & { asset_id: string }>;
  return assets
    .map((asset) => rowToAssetBundle(asset.asset_id))
    .filter((bundle): bundle is AssetBundle => bundle !== null)
    .map(bundleToProjection);
}

export function getCanonicalMediaAsset(projectId: string, assetId: string): MediaAsset | null {
  ensureProjectMigrated(projectId);
  const bundle = rowToAssetBundle(assetId);
  if (!bundle || bundle.asset.project_id !== projectId) return null;
  return bundleToProjection(bundle);
}

export function registerCanonicalMediaAsset(input: CanonicalRegisterInput): MediaAsset {
  ensureProjectMigrated(input.projectId);

  const db = getCanonicalAssetDb();
  const timestamp = nowIso();
  const fileHash = computeFileHashSync(input.filePath);
  const sourceAvailable = input.filePath && fs.existsSync(input.filePath) ? 1 : 0;

  if (input.existingAssetId) {
    const latestVersion = getLatestVersionForAsset(input.existingAssetId);
    const latestMedia = latestVersion ? getPrimaryMediaFileForVersion(latestVersion.asset_version_id) : null;
    const duplicate = latestMedia && fileHash && latestMedia.content_hash === fileHash;
    const versionNumber = (latestVersion?.version_number ?? 0) + 1;
    const versionId = randomUUID();
    const assetId = input.existingAssetId;

    insertVersion({
      asset_version_id: versionId,
      asset_id: assetId,
      version_number: versionNumber,
      version_label: null,
      ingest_mode: input.storageType === 'uploaded' ? 'manual' : 'observed',
      status: duplicate ? 'duplicate' : 'ready',
      exported_at: null,
      ingested_at: timestamp,
      export_preset: null,
      edit_label_at_export: null,
      source_event_id: null,
      replaced_by_version_id: null,
      supersedes_version_id: latestVersion?.asset_version_id ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    insertMediaFile({
      media_file_id: randomUUID(),
      asset_version_id: versionId,
      role: 'primary',
      source_path: input.filePath,
      managed_path: input.filePath,
      storage_class: getStorageClass(input.storageType),
      original_filename: input.originalFilename,
      managed_filename: input.filePath ? path.basename(input.filePath) : null,
      mime_type: input.mimeType ?? null,
      file_size_bytes: input.fileSize,
      content_hash: fileHash,
      source_modified_at: sourceModifiedAt(input.filePath),
      copied_to_managed_at: input.filePath ? timestamp : null,
      is_source_available: sourceAvailable,
      is_managed_available: sourceAvailable,
      displacement_status: 'normal',
      created_at: timestamp,
      updated_at: timestamp,
    });

    db.prepare('UPDATE assets SET updated_at = ? WHERE asset_id = ?').run(timestamp, assetId);
    return getCanonicalMediaAsset(input.projectId, assetId)!;
  }

  const assetId = input.assetId ?? randomUUID();
  const versionId = randomUUID();
  insertAsset({
    asset_id: assetId,
    project_id: input.projectId,
    client_code: null,
    display_label: null,
    current_display_name: input.name ?? input.originalFilename,
    description: input.description ?? '',
    tags_json: JSON.stringify(input.tags ?? []),
    status: 'active',
    source_system: 'lpos',
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
    migration_source: null,
    migrated_at: null,
  });

  insertVersion({
    asset_version_id: versionId,
    asset_id: assetId,
    version_number: 1,
    version_label: null,
    ingest_mode: input.storageType === 'uploaded' ? 'manual' : 'observed',
    status: 'ready',
    exported_at: null,
    ingested_at: timestamp,
    export_preset: null,
    edit_label_at_export: null,
    source_event_id: null,
    replaced_by_version_id: null,
    supersedes_version_id: null,
    created_at: timestamp,
    updated_at: timestamp,
  });

  insertMediaFile({
    media_file_id: randomUUID(),
    asset_version_id: versionId,
    role: 'primary',
    source_path: input.filePath,
    managed_path: input.filePath,
    storage_class: getStorageClass(input.storageType),
    original_filename: input.originalFilename,
    managed_filename: input.filePath ? path.basename(input.filePath) : null,
    mime_type: input.mimeType ?? null,
    file_size_bytes: input.fileSize,
    content_hash: fileHash,
    source_modified_at: sourceModifiedAt(input.filePath),
    copied_to_managed_at: input.filePath ? timestamp : null,
    is_source_available: sourceAvailable,
    is_managed_available: sourceAvailable,
    displacement_status: 'normal',
    created_at: timestamp,
    updated_at: timestamp,
  });

  return getCanonicalMediaAsset(input.projectId, assetId)!;
}

export function patchCanonicalMediaAsset(projectId: string, assetId: string, patch: CanonicalAssetPatch): MediaAsset | null {
  ensureProjectMigrated(projectId);
  const current = getCanonicalMediaAsset(projectId, assetId);
  if (!current) return null;

  upsertAssetFields(assetId, patch);
  upsertMediaFileFields(assetId, patch);

  if (patch.transcription) {
    upsertTranscriptionRecord(assetId, patch.transcription);
  }

  if (patch.frameio) {
    createOrUpdateDistributionRecord(assetId, 'frameio', {
      provider_status: patch.frameio.status,
      provider_asset_id: patch.frameio.assetId,
      published_at: patch.frameio.uploadedAt,
      review_url: patch.frameio.reviewLink,
      playback_url: patch.frameio.playerUrl,
      last_error: patch.frameio.lastError,
      ...patch.frameio,
    });
  }

  if (patch.cloudflare) {
    createOrUpdateDistributionRecord(assetId, 'cloudflare', {
      provider_status: patch.cloudflare.status,
      provider_asset_id: patch.cloudflare.uid,
      published_at: patch.cloudflare.uploadedAt,
      ready_at: patch.cloudflare.readyAt,
      playback_url: patch.cloudflare.previewUrl,
      thumbnail_url: patch.cloudflare.thumbnailUrl,
      last_error: patch.cloudflare.lastError,
      ...patch.cloudflare,
    });
  }

  if (patch.leaderpass) {
    createOrUpdateDistributionRecord(assetId, 'leaderpass', {
      provider_status: patch.leaderpass.status,
      provider_asset_id: patch.leaderpass.contentId,
      provider_parent_id: patch.leaderpass.tileId,
      published_at: patch.leaderpass.publishedAt,
      playback_url: patch.leaderpass.playbackUrl,
      thumbnail_url: patch.leaderpass.thumbnailUrl,
      last_error: patch.leaderpass.lastError,
      ...patch.leaderpass,
    });
  }

  return getCanonicalMediaAsset(projectId, assetId);
}

export function removeCanonicalMediaAsset(projectId: string, assetId: string): MediaAsset | null {
  ensureProjectMigrated(projectId);
  const asset = getCanonicalMediaAsset(projectId, assetId);
  if (!asset) return null;

  const db = getCanonicalAssetDb();
  db.prepare('DELETE FROM assets WHERE asset_id = ? AND project_id = ?').run(assetId, projectId);
  return asset;
}

export function overwriteCanonicalProjections(projectId: string, assets: MediaAsset[]): void {
  for (const asset of assets) {
    const current = getCanonicalMediaAsset(projectId, asset.assetId);
    if (!current) continue;

    const patch: CanonicalAssetPatch = {};

    if (current.name !== asset.name) patch.name = asset.name;
    if (current.description !== asset.description) patch.description = asset.description;
    if (JSON.stringify(current.tags) !== JSON.stringify(asset.tags)) patch.tags = asset.tags;
    if (current.filePath !== asset.filePath) patch.filePath = asset.filePath;
    if (current.fileSize !== asset.fileSize) patch.fileSize = asset.fileSize;
    if (JSON.stringify(current.transcription) !== JSON.stringify(asset.transcription)) patch.transcription = asset.transcription;
    if (JSON.stringify(current.frameio) !== JSON.stringify(asset.frameio)) patch.frameio = asset.frameio;
    if (JSON.stringify(current.cloudflare) !== JSON.stringify(asset.cloudflare)) patch.cloudflare = asset.cloudflare;
    if (JSON.stringify(current.leaderpass) !== JSON.stringify(asset.leaderpass)) patch.leaderpass = asset.leaderpass;

    if (Object.keys(patch).length > 0) {
      patchCanonicalMediaAsset(projectId, asset.assetId, patch);
    }
  }
}

export function findCanonicalVersionCandidate(
  projectId: string,
  filename: string,
  filePath: string | null,
): CanonicalVersionCandidate | null {
  const incomingKey = normalizeAssetKey(filename);
  if (!incomingKey) return null;

  const assets = listCanonicalMediaAssets(projectId);
  const matchingAsset = [...assets].reverse().find((asset) => (
    normalizeAssetKey(asset.name) === incomingKey
    || normalizeAssetKey(asset.originalFilename) === incomingKey
  ));

  if (!matchingAsset) return null;

  const currentVersion = getLatestNonDuplicateVersionForAsset(matchingAsset.assetId);
  const currentMedia = currentVersion ? getPrimaryMediaFileForVersion(currentVersion.asset_version_id) : null;
  const incomingHash = computeFileHashSync(filePath);
  const duplicate = Boolean(incomingHash && currentMedia?.content_hash && incomingHash === currentMedia.content_hash);

  return {
    asset: matchingAsset,
    duplicate,
    currentVersionNumber: currentVersion?.version_number ?? 1,
    incomingLabel: stripExtension(filename),
  };
}

export function getLatestDistributionInfoForAsset(
  assetId: string,
  provider: CanonicalDistributionProvider,
): CanonicalDistributionRecord | null {
  const bundle = rowToAssetBundle(assetId);
  if (!bundle) return null;
  return bundle.distributions.find((distribution) => distribution.provider === provider) ?? null;
}

export function migrateLegacyProject(projectId: string): number {
  ensureProjectMigrated(projectId);
  return listCanonicalMediaAssets(projectId).length;
}

export function migrateAllLegacyProjects(): { projectId: string; assetCount: number }[] {
  const projectsDir = path.join(DATA_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const results: { projectId: string; assetCount: number }[] = [];
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectId = entry.name;
    const assetCount = migrateLegacyProject(projectId);
    results.push({ projectId, assetCount });
  }
  return results;
}

export function getCurrentAssetVersion(assetId: string): CanonicalAssetVersion | null {
  return getLatestNonDuplicateVersionForAsset(assetId);
}
