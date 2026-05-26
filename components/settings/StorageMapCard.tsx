import { env } from 'node:process';

type ServiceTag = 'r2' | 'stream' | 'images' | 'b2' | 'local';

interface StorageItem {
  name:    string;
  service: ServiceTag;
  label:   string;
  bucket:  string;
  detail:  string;
}

const SERVICE_META: Record<ServiceTag, { display: string; className: string }> = {
  r2:     { display: 'Cloudflare R2',     className: 'storage-map-badge--r2'     },
  stream: { display: 'Cloudflare Stream', className: 'storage-map-badge--stream' },
  images: { display: 'Cloudflare Images', className: 'storage-map-badge--images' },
  b2:     { display: 'Backblaze B2',      className: 'storage-map-badge--b2'     },
  local:  { display: 'Local drives',      className: 'storage-map-badge--local'  },
};

function getItems(): StorageItem[] {
  const deliveryBucket    = env.R2_BUCKET              ?? '$R2_BUCKET';
  const attachmentsBucket = env.R2_ATTACHMENTS_BUCKET  ?? '$R2_ATTACHMENTS_BUCKET';
  const backupBucket      = env.R2_BACKUP_BUCKET       ?? '$R2_BACKUP_BUCKET';

  return [
    {
      name:    'Project Media',
      service: 'local',
      label:   'Managed drive volumes',
      bucket:  'Storage → Drive Settings',
      detail:
        'Raw project files — video, audio, and images — written to whichever local drive is currently active in LPOS\'s storage allocation. LPOS owns the folder structure under its managed root. When a drive reaches the configured capacity threshold, LPOS automatically advances to the next enabled volume. These files are not cloud-backed by LPOS; NAS-to-B2 backup is handled externally.',
    },
    {
      name:    'Delivery Files',
      service: 'r2',
      label:   deliveryBucket,
      bucket:  deliveryBucket,
      detail:
        'Originals, proxy versions, thumbnails, and VTT transcripts are uploaded here when a delivery link is created in lpos-ingest. An hourly sweep checks for expired links and deletes all associated R2 keys (including proxies and transcripts) roughly one hour after expiry. Manual revocation via the LPOS dashboard deletes files immediately. The delivery link creator is notified in-app and via Slack DM when a link expires.',
    },
    {
      name:    'Comment & Prospect Attachments',
      service: 'r2',
      label:   attachmentsBucket,
      bucket:  attachmentsBucket,
      detail:
        'Files attached to task comments and prospect update notes. Uploaded on submission, deleted when the parent comment is deleted. A 60-day R2 object lifecycle rule acts as a safety net for any orphaned keys that slip through.',
    },
    {
      name:    'App Database & Config Backups',
      service: 'r2',
      label:   backupBucket,
      bucket:  backupBucket,
      detail:
        'Nightly backup of all *.sqlite databases and top-level *.json config files in the LPOS data directory. SQLite snapshots are taken via VACUUM INTO for consistency while the database is live, then gzip-compressed before upload. Falls back to a local data/backups/ folder if R2 credentials are absent. Retention: 7 days by default (LPOS_BACKUP_RETAIN_DAYS). Project subdirectories, .env.local, and the lpos-server-app directory are not included.',
    },
    {
      name:    'Video Streaming',
      service: 'stream',
      label:   'Cloudflare Stream',
      bucket:  'Account: $CLOUDFLARE_ACCOUNT_ID',
      detail:
        'Videos are uploaded to Cloudflare Stream via TUS (resumable, 32 MB chunks by default) and transcoded by Cloudflare into HLS and DASH adaptive streams. LPOS tracks the stream UID, status, and readyAt timestamp on each asset. Deleted from Stream when the LPOS asset is deleted. A daily orphan reconciler compares Cloudflare\'s video list against live LPOS assets and flags any mismatches in the admin panel for manual cleanup.',
    },
    {
      name:    'Posters & Thumbnails',
      service: 'images',
      label:   'Cloudflare Images',
      bucket:  'Account: $CLOUDFLARE_ACCOUNT_ID',
      detail:
        'Project poster images uploaded via the batch-poster flow. LPOS stores the Cloudflare image ID on each asset and serves thumbnails via Cloudflare\'s CDN using the configured variant (default: public). Not currently wired to auto-delete when an asset is removed — image IDs may persist in Cloudflare Images after an LPOS asset deletion.',
    },
    {
      name:    'NAS Cold Archive',
      service: 'b2',
      label:   'Backblaze B2',
      bucket:  'External — not managed by LPOS',
      detail:
        'The NAS active folder (~3.5 TB) is backed up to Backblaze B2 via Synology backup jobs. This is fully external to LPOS — no LPOS code reads from or writes to this bucket. Egress is free through the Cloudflare Bandwidth Alliance. Cost is roughly $6/TB/month, typically $12–25/month depending on active project volume.',
    },
  ];
}

export function StorageMapCard() {
  const items = getItems();

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Storage map</h2>
        <p className="storage-settings-muted">
          Where every category of LPOS data lives and how it&rsquo;s managed.
        </p>
      </div>

      <div className="storage-map-grid">
        {items.map((item) => {
          const meta = SERVICE_META[item.service];
          return (
            <div key={item.name} className="storage-map-item">
              <div className="storage-map-header">
                <span className="storage-map-name">{item.name}</span>
                <span className={`storage-map-badge ${meta.className}`}>{meta.display}</span>
                <span className="storage-map-tip" aria-label={`More info: ${item.name}`}>
                  ?
                  <span className="storage-map-tip-content" role="tooltip">
                    {item.detail}
                  </span>
                </span>
              </div>
              <span className="storage-map-bucket">{item.bucket}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
