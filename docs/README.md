# LPOS Dashboard — Process Documentation

## Media Ingest Pipeline

### What it does
Handles browser → server file uploads and tracks them through to Frame.io and LeaderPass/Cloudflare publishing.

### Key files and entry points
| File | Role |
|------|------|
| `components/projects/MediaTab.tsx` | Upload UI — XHR upload, progress tracking, drop zone |
| `app/api/projects/[projectId]/media/route.ts` | POST handler — receives multipart body via busboy, writes file to disk, creates ingest job |
| `lib/services/ingest-queue-service.ts` | Tracks ingest jobs in SQLite; broadcasts state via Socket.io `/media-ingest` |
| `components/shell/IngestTray.tsx` | Live ingest status pill/card; opens when any queued/ingesting job exists |
| `hooks/useIngestQueue.ts` | Client-side Socket.io hook for ingest job state |

### Data flow
1. **Client** sends `POST /api/projects/:id/media` (multipart/form-data) with an `x-upload-filename` header containing the percent-encoded filename.
2. **Route handler** immediately creates an ingest job (status: `queued`) from the header filename and broadcasts it via Socket.io → IngestTray opens.
3. **busboy** parses the body through a 64 KB chunk-size limiter (prevents `ERR_OUT_OF_RANGE` on files > 2 GB).
4. **Stream data events** update ingest progress (capped at 95%) while the file writes to disk.
5. On **write finish**: SHA-256 hash computed, asset registered, file renamed to stable path, ingest job marked `done` (100%).
6. **`triggerFrameIOUpload`** starts a background Frame.io upload (tracked separately in UploadQueueService / UploadTray).

### Large-file handling
- Files ≥ 1.9 GB are compressed to H.264 proxy via ffmpeg before Frame.io upload (`frameio-compress.ts`).
- Body chunk limiter (`TransformStream`, 64 KB max) in `media/route.ts` prevents Node.js Buffer allocation errors for bodies > INT32_MAX (2 147 483 647 bytes).

### Pre-reservation pattern
Before the upload loop starts, `MediaTab.tsx` calls `POST /api/projects/:id/ingest-queue/reserve` with all filenames, creating every job as `queued` immediately. All files appear in the IngestTray before any XHR begins. Each `uploadFile` call passes the reserved `jobId` in an `x-ingest-job-id` header; the route reuses it instead of creating a duplicate.

### Page-leave protection
`uploadFiles()` registers a `beforeunload` handler for the duration of the upload loop. If the user tries to navigate away or refresh while uploads are in progress the browser shows its native "Leave site?" confirmation dialog. The handler is removed once all uploads finish.

### Stale queued job sweep
`IngestQueueService` runs a sweep every 2 minutes. Jobs that are `queued` with no `temp_path` (upload never started — client left before the XHR began) and older than 10 minutes are auto-failed. The sweep is skipped when any job is actively `ingesting` (queued jobs in that case are legitimately waiting their turn).

### Current status
Ingest, Frame.io upload, and Cloudflare/LeaderPass publish pipelines are all operational. Boot recovery handles interrupted ingests on server restart. Stale pre-reserved jobs are cleaned up automatically every 2 minutes.

---

## Frame.io Upload Pipeline

### Key files
| File | Role |
|------|------|
| `lib/services/frameio-upload.ts` | Orchestrates compression + S3 upload + asset patching |
| `lib/services/frameio.ts` | Frame.io V4 API client; chunked S3 upload via ReadableStream |
| `lib/services/frameio-compress.ts` | ffmpeg H.264 proxy for files ≥ 1.9 GB |
| `lib/services/upload-queue-service.ts` | In-memory upload job tracker; broadcasts via Socket.io `/upload-queue` |
| `components/shell/UploadTray.tsx` | Live upload status UI |

### Data flow
Asset registered → `triggerFrameIOUpload` (fire-and-forget) → optional ffmpeg compress → Frame.io `local_upload` → S3 PUT (streamed per part) → asset patched with `frameioAssetId` + `reviewLink`.

---

## LeaderPass / Cloudflare Stream Pipeline

### Key files
| File | Role |
|------|------|
| `lib/services/leaderpass-publish.ts` | Orchestrates TUS upload to Cloudflare + polling for ready state |
| `lib/services/cloudflare-stream.ts` | TUS protocol implementation; 32 MB chunks; retry logic |

### Data flow
Publish triggered → Cloudflare TUS upload init → chunked PATCH uploads → poll for `ready` status → asset patched with stream UIDs and URLs.
