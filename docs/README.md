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
Asset registered → `triggerFrameIOUpload` (fire-and-forget) → optional ffmpeg compress → Frame.io `local_upload` → S3 PUT (streamed per part) → version stack create/extend (if replacing) → asset patched with `frameioAssetId` + `stackId` + `reviewLink`.

### Version stacking
When a v2+ asset is uploaded with `replaceAssetId`, the upload route reads the prior version's `frameio.assetId` and `frameio.stackId` and passes them to `triggerFrameIOUpload`. After the S3 upload completes:
- **First replacement (v1→v2):** `createVersionStack(folderId, priorFileId, newFileId)` — POST `.../version_stacks` — creates a Frame.io version stack containing both files. The stack ID is stored in `frameio.stackId`; the stack's `view_url` becomes the review link.
- **Subsequent replacements (v2→v3+):** `addFileToVersionStack(newFileId, stackId)` — PATCH `.../files/{id}/move` — moves the new file into the existing stack. Existing review links and share links automatically resolve to the latest version.

All versioning failures are non-fatal (logged as warnings) to avoid blocking the upload if the stack API is unavailable.

---

## Frame.io Comment Sync

### What it does
Shows Frame.io review comments in the media detail panel and theater mode, and lets operators post, reply, edit, delete, and **check off (mark complete)** comments. Comments are NOT mirrored in a local DB — Frame.io is the single source of truth. LPOS only stores side metadata locally: comment author names (`comment-authors-store`) and the parent links for replies posted as fake top-level comments (`comment-replies-store`).

### Key files
| File | Role |
|------|------|
| `lib/services/frameio.ts` | `getComments` / `postComment` / `postReply` / `updateComment` / `deleteComment` / `toggleCommentCompleted` (Frame.io V4 API) |
| `app/api/projects/[projectId]/media/[assetId]/frameio/comments/route.ts` | GET/POST/PATCH/DELETE proxy to Frame.io + author/reply metadata enrichment |
| `app/api/webhooks/frameio/route.ts` | Verifies Frame.io HMAC webhooks; emits Socket.io `frameio:comments:refresh` for any comment event |
| `components/media/MediaDetailPanel.tsx` | Owns the comment list state, refresh subscription, and the completed-toggle optimistic guard |
| `components/media/VideoTheaterMode.tsx` | Theater-mode comment UI; toggles via its own PATCH and reports back to the panel via `onCommentCompleted` |
| `lib/services/comment-notification-service.ts` | `notifyCommentReply` — persists + emits `comment:notification` + web-push when a reply lands on an LPOS-authored comment |
| `lib/store/comment-notification-store.ts` | `comment_notifications` CRUD (per-user list, unread count, mark read/all-read) |
| `app/api/notifications/comments/route.ts` + `[notifId]/route.ts` | Per-user GET list/unread + mark-all-read; per-notif mark-read |
| `hooks/useCommentNotifications.ts` + `components/shell/NotifBell.tsx` | Comments tab in the notif bell (live via Socket.io, deep-links to the asset) |

### Replies (Frame.io has no reply endpoint)
Frame.io V4 can't create replies, so `postReply` posts a **top-level** comment prefixed `"Reply to above: "` (reviewers still see context in Frame.io) and records `replyId → parentId` in `data/projects/{id}/comment-replies.json` (`comment-replies-store`). On GET, the route filters out any comment whose ID is in that map, strips the prefix, and injects it into its parent's `replies[]` array to rebuild the thread.

### How it refreshes (inputs → outputs)
- **On open / 5-min fallback poll:** `fetchComments()` GETs the full list from Frame.io.
- **Real-time:** any Frame.io comment event (`created/updated/completed/uncompleted/deleted`) hits the webhook, which pushes `frameio:comments:refresh` over Socket.io; the panel re-fetches only if the event's `projectId`/`assetId` matches the open asset.

### Reply notifications (Comments tab in the notif bell)
When a reply lands on a comment, the POST route notifies the original commenter via `notifyCommentReply` (`comment-notification-service`) → persists to `comment_notifications` (core-db) → emits Socket.io `comment:notification` to `user:{userId}` + best-effort web-push. The notif bell's **Comments** tab (`useCommentNotifications` → `/api/notifications/comments`) shows them; clicking deep-links to `/projects/{id}?assetId={asset}`. This is its own notification category alongside Tasks/Prospects/Deliveries (the "Pipeline" tab is unrelated — client-only, ephemeral).
- **Constraint:** only fires when the parent comment was authored *inside LPOS* (we have the author's `userId` in `comment-authors-store`). Replies to external Frame.io reviewers have no in-app recipient and notify no one. Self-replies are skipped.

### Completed-toggle optimistic guard
The "check off" flag lives only in Frame.io, and a user's PATCH is exactly what makes Frame.io fire its `comment.completed` webhook — which relays back as a refresh a beat later. Frame.io's read API briefly lags its own webhook (read-after-write), so a refetch in that window returns the pre-toggle value. To stop the checkbox visibly resetting moments after a click:
- `handleToggleComplete` records the desired value in `pendingTogglesRef` and flips the UI optimistically. On success it **keeps** the guard (clearing it on failure alongside a revert).
- `fetchComments` masks each comment with its pending value and **only drops the guard once the fetched `completed` matches it** — i.e. Frame.io has propagated the write. After that, genuine external changes flow through normally.
- Theater-mode toggles register the same guard via the panel's `onCommentCompleted` callback.

### Current status / known gaps
- Working; the sticky guard tolerates arbitrary Frame.io read-after-write lag without a fixed timeout.
- A comment deleted while its toggle is still pending leaves a harmless orphaned entry in the in-memory guard map (bounded by comment count, cleared on panel close).
- Reply notifications cover only LPOS-authored parent comments (external Frame.io reviewers can't be notified in-app). No notification yet for *new top-level* comments left in LPOS — only replies.

---

## LeaderPass / Cloudflare Stream Pipeline

### Key files
| File | Role |
|------|------|
| `lib/services/leaderpass-publish.ts` | Orchestrates TUS upload to Cloudflare + polling for ready state |
| `lib/services/cloudflare-stream.ts` | TUS protocol implementation; 32 MB chunks; retry logic |

### Data flow
Publish triggered → Cloudflare TUS upload init → chunked PATCH uploads → poll for `ready` status → asset patched with stream UIDs and URLs.

---

## LeaderPass AI Provisioning

Pushes a project's videos into LeaderPass AI ("LP.AI") for search / Q&A. The LP.AI side is a separate project; LPOS only implements the provisioning (push) half of the contract.

### What it does
A per-project **"Use in LeaderPass AI"** toggle. When ON, each Cloudflare-ready video in the project is POSTed to LP.AI's ingest endpoint — one request per video — carrying the project name (`pass`), the Cloudflare Stream UID, the title, and a **high-quality `large-v3-turbo` word-level transcript** mapped to millisecond `{startMs,endMs,text}` cues.

### Turbo-on-provision (the transcript sent to LP.AI is NOT the base transcript)
Normal LPOS ingest transcribes on **`base`** (fast, snappy) and that transcript backs the Transcripts UI — it is never touched. LP.AI needs the best transcript, so **at provision time** we produce a separate high-quality pass:

1. **Cache check** — `findCachedTurboJobId()` reads `lpos_settings` key `lpai.turbo.<projectId>.<assetId>` (a `{model, jobId, completedAt}` marker), then confirms the marker's `<jobId>.words.json` still exists and the whisper JSON's `params.model` is turbo-quality (`large-v3-turbo` / `large-v3`). If good, re-transcription is skipped.
2. **Produce** — otherwise `enqueueSidecar()` queues a transcription job with `purpose: 'lpai_sidecar'` and `model` overridden to `large-v3-turbo` (whisper-upgrade's per-job `process({model})` path). It writes a fresh `<jobId>.*` fileset but keeps only `.json` + `.words.json` (the human-facing `.txt/.srt/.vtt` are dropped so it never appears in the Transcripts UI). It writes **no** `.meta.json`, does **not** prune the base transcript, and does **not** touch `asset.transcription.*`.
3. **Wait (non-blocking)** — `ensureTurboTranscript()` awaits only *that* asset's turbo job via an `onJobComplete` waiter; the batch loop fans out per-asset so each video pushes as its own turbo transcript finishes. The whole batch runs fire-and-forget off the request thread.
4. **Push** — read the turbo `<jobId>.words.json` → ms cues → POST to LP.AI. On turbo failure it falls back to the base transcript so the video still ships.

### Key files
| File | Role |
|------|------|
| `lib/services/lpai-provisioning.ts` | Config read, per-project toggle KV, **turbo cache + enqueue + waiter**, transcript→cue mapping, single/batch/auto push, activity logging |
| `lib/services/transcripter-service.ts` | `enqueueSidecar()` (per-job model + `lpai_sidecar` purpose), sidecar meta/prune skip + UI-file cleanup |
| `lib/services/container.ts` | Global `onJobComplete` handler skips `lpai_sidecar` jobs (won't re-point asset transcript / Drive / captions) |
| `lib/services/pipeline-tracker-service.ts` | `syncTranscript` ignores `lpai_sidecar` jobs (no phantom pipeline stage) |
| `app/api/projects/[projectId]/lpai/route.ts` | GET toggle state; PUT set toggle (toggle-ON triggers batch provisioning) |
| `app/api/projects/[projectId]/lpai/reprovision/route.ts` | POST manual re-provision; returns **202 accepted** (background batch) |
| `components/projects/LeaderPassAiToggle.tsx` | Header control (checkbox + Re-provision + background-started notice) |
| `lib/services/leaderpass-publish.ts` | Calls `triggerAutoProvisionOnFinalize` after a successful CF publish |

### Config
- **Credentials (Doppler/env):** `LPAI_BASE_URL`, `LPAI_PROVISIONING_SECRET` (== LP.AI's `PROVISIONING_SECRET`). If either is unset the whole feature is a silent no-op.
- **Turbo model (optional env):** `LPAI_TURBO_MODEL`, default `large-v3-turbo`. The model file must be staged at `runtime/whisper-models/ggml-<model>.bin`.
- **Per-project toggle (SQLite `lpos_settings`):** key `lpai.enabled.<projectId>`, default OFF.
- **Turbo cache marker (SQLite `lpos_settings`):** key `lpai.turbo.<projectId>.<assetId>`, auto-written after a turbo pass completes.

### Contract (do not change — target it)
`POST ${LPAI_BASE_URL}/api/ingest`, header `Authorization: Bearer ${LPAI_PROVISIONING_SECRET}`, body `{ pass, cloudflareUid, title, transcript: [{startMs,endMs,text}] }`.

### Data flow (inputs → outputs)
Toggle-ON / Re-provision / CF-publish-complete → read project assets (`readRegistry`) → for each asset with `cloudflare.uid` + `status==='ready'`: **ensure turbo transcript** (cache hit, else enqueue `large-v3-turbo` sidecar + wait) → load its `<jobId>.words.json` → map to ms cues → POST to LP.AI ingest. Per-video failures are isolated; each push logs `lpai.ingest.*` / `lpai.project.*` activity events. Sidecar transcription events are `operator_only` so they don't duplicate the user timeline.

### Triggers
- **Toggle-ON:** provisions all current videos (fire-and-forget background batch).
- **Manual Re-provision:** fire-and-forget background batch, returns 202 immediately (turbo transcription can take minutes).
- **Auto on finalize:** hooked at LeaderPass-publish completion (first moment a CF UID exists), gated on the toggle + config.

### Current status / known gaps
- Provisioning is a background transcribe-then-push batch — no longer instant (expected).
- Auto-provision only fires via the LeaderPass publish path.
- Toggle-OFF stops future pushes only; LP.AI-side removal is not implemented.
- If the turbo word-level pass fails but the segment pass succeeds, the cache check (which requires `.words.json`) re-triggers turbo next provision; the push still uses turbo-quality segment cues meanwhile.

---

## Authentication & Access Control

### Roles
| Role | How assigned | Access |
|------|-------------|--------|
| `admin` | Google OAuth login with email in admin list (`data/admins.json` or bootstrap `LPOS_BOOTSTRAP_ADMIN`) | Full access + admin settings |
| `user` | Google OAuth login (any provisioned account) | Full app access |
| `guest` | Daily PIN entry at `/guest-pin` | `/guest`, `/guest/scripts`, `/slate`, `/api/presentation/*`, `/projects/[id]/scripts` only |

### Key files
| File | Role |
|------|------|
| `lib/services/session-auth.ts` | JWT-like HMAC session tokens with `role` field |
| `lib/services/api-auth.ts` | `requireRole(req, minimumRole)` helper for route handlers |
| `lib/store/admin-store.ts` | Bootstrap admin + persistent extra admins in `data/admins.json` |
| `lib/services/guest-pin.ts` | Daily 4-digit PIN via HMAC-SHA256(LPOS_AUTH_SECRET, date) |
| `middleware.ts` | Edge auth gate; path allow-list enforcement for guests |
| `app/api/auth/google/callback/route.ts` | Assigns role on Google OAuth login |
| `app/api/auth/guest/route.ts` | POST; verifies PIN, issues guest session |
| `app/api/admin/admins/route.ts` | GET/POST/DELETE admin email management |

### Guest access flow
1. Device navigates to `http://172.20.10.138:3000` (LAN) or Tailscale URL.
2. Sign-in page → "Continue as Guest" → `/guest-pin` (public path, no auth required).
3. Operator provides today's 4-digit PIN (visible in Settings → Guest Access PIN).
4. PIN verified server-side; guest session cookie set → redirect to `/guest`.
5. Guest home shows two tiles: **Presentation** and **Script Upload**.
6. Any navigation outside the allow-list → redirect to `/guest?blocked=1`.

### Daily PIN
- Derived via HMAC-SHA256(`LPOS_AUTH_SECRET`, `lpos-guest-pin:YYYY-MM-DD`).
- No storage required; same PIN re-derived on every call until midnight UTC.
- Visible to admins at Settings → Guest Access PIN.
- Local URL for studio devices: `http://172.20.10.138:3000` (allowed via `APP_LOCAL_URL` in Socket.io CORS).

### Admin management
- Bootstrap admin hardcoded via `LPOS_BOOTSTRAP_ADMIN` env (default: `jordan@leaderpass.com`). Cannot be removed via UI.
- Additional admins managed via Settings → Admins panel (`AdminsPanel` component → `POST /api/admin/admins`).

### Credential rotation
See `docs/credential-rotation-runbook.md` for step-by-step rotation of all secrets.

## Attachments

File attachments on **task comments** and **prospect updates**. Both contexts share one storage backend and one serving endpoint; only the authorization differs.

### What it does
Lets users attach files (≤ 10 MB) to task comments and prospect updates. Files are stored in a Cloudflare R2 bucket and served back through a single download endpoint. Images and PDFs render inline; everything else downloads.

### Key files and entry points
- `lib/services/r2-attachments.ts` — generic, domain-agnostic R2 helpers (`uploadAttachment` / `fetchAttachment` / `deleteAttachment`). No knowledge of tasks or prospects.
- `app/api/attachment/route.ts` — shared **GET** serve/download endpoint for all attachments.
- `app/api/tasks/[taskId]/comments/attachments/route.ts` — **POST** upload for task comments.
- `app/api/prospects/[prospectId]/updates/attachments/route.ts` — **POST** upload for prospect updates.
- `components/tasks/CommentThread.tsx` — renders task-comment attachment chips/images.
- `components/prospects/UpdatesLog.tsx` — renders prospect-update attachment chips/images.

### Data flow (inputs → outputs)
1. Upload (multipart `file`) → domain route validates session/access + parent existence, mints a key, calls `uploadAttachment`, returns `{ key, name, mime, size }`.
2. The `{ key, name, mime, size }` record is persisted in the parent's `attachments` JSON column (`task_comments.attachments` / `prospect_updates.attachments`).
3. Render → frontend links to `/api/attachment?key=<key>`.
4. Download → the serve endpoint authorizes, then streams bytes from R2.

### Key namespacing & authorization
Keys are minted server-side, so the key prefix is a trusted discriminator for the serve endpoint:
- `attachments/tasks/<taskId>/…` — **task** attachments → require only a valid session (matches task-comment uploads, which are not gated on Prospects).
- `attachments/<prospectId>/…` — **prospect** attachments → require Prospects access (`requireProspectsAccess`).

The serve endpoint validates the key (`attachments/` prefix, no `..`), then branches on the `attachments/tasks/` prefix to pick the right auth check.

### Current status / known gaps
- No per-resource ACL on downloads: any authenticated user can fetch any task-attachment key, and any Prospects-enabled user can fetch any prospect-attachment key. There is no "can this user see *this specific* task/prospect" check — this matches how uploads currently authorize. Tightening would mean moving downloads to resource-nested routes (`/api/tasks/[taskId]/…/attachment`).
- Orphaned objects are reaped by a 60-day R2 lifecycle rule rather than synchronous deletes.

## Responsive Layout & Mobile

How the app adapts between desktop and phone-sized screens.

### What it does
Pages share one global stylesheet and a single shell. The chrome swaps form factor at a breakpoint, and individual layouts collapse their columns/rows as the viewport narrows so content stays on screen.

### Key files
| File | Role |
|------|------|
| `components/shell/AppShell.tsx` | Top-level shell. Home (`/`) renders a chrome-free hero variant; all other routes render the nav + breadcrumb + `main.app-content` variant. |
| `components/shell/NavBar.tsx` | Renders both navs: a floating desktop pill (`.navbar`) and a mobile bottom tab bar (`.bottom-tab-bar`). CSS decides which is visible. |
| `components/projects/ProjectWorkflowNav.tsx` | The 7-stage project workflow nav (`.workflow-nav`). |
| `app/globals.css` | All styling, including every responsive rule. |

### How it adapts (inputs → outputs)
- **Navigation chrome:** at `≤768px` the desktop pill (`.navbar`) hides and the fixed `.bottom-tab-bar` (~56px tall) shows. At `≤430px` the tab bar drops its text labels (icons only).
- **Content insets:** `.app-content` reserves bottom padding for the tab bar (`56px + env(safe-area-inset-bottom)`); fixed bottom-corner UI (`.storage-gear-link`, `.tray-group`) and slide-in side panels (`.sh-panel`, `.sep`) are lifted above it.
- **Layout collapse:** multi-column grids (`.proj-grid`, `.proj-client-grid`, `.workflow-nav`, dashboard grids) reduce column counts as width drops; the project workflow nav and the project detail tab strip (`.proj-tabs`) become horizontal-scroll strips on mobile.

### Breakpoint conventions
Established `max-width` breakpoints, used consistently across the file: **1300, 1100, 900, 768, 700, 480, 430px**. `768px` is the primary desktop↔mobile chrome switch; `480/430px` handle the narrowest phones. New responsive rules should reuse these values. The consolidated "Mobile layout fixes" block at the end of `globals.css` is appended last so its mobile-only rules win over earlier equal-specificity rules without editing them.

### Current status / known gaps
- Mobile fixes are CSS-only and verified by source analysis, not yet on-device (no browser-automation tooling installed; production server is auth-gated).
- Minor non-blocking whitespace items remain (platform page inline `60vh`, `.activity-strip-item` max-width) — they don't cut content off.

## Navigation Invariants

Rules the shell honors so a user can always escape any view. New UI must not violate these.

### What it does
The top-left **breadcrumb bar** (`Breadcrumb.tsx`) hosts the back arrow + home icon + path crumbs. The home icon links to `/` and is the universal escape hatch. The bar is rendered on every non-home route by `AppShell` and is always clickable.

### Key files
| File | Role |
|------|------|
| `components/shell/Breadcrumb.tsx` | Renders the back arrow, home `<Link href="/">`, and the path crumbs. Mounted unconditionally on every non-home route. |
| `components/shell/AppShell.tsx` | Mounts `<Breadcrumb />` inside the `app-inner` shell (every route except `/`, which is itself the home). |
| `app/globals.css` (`.breadcrumb-bar`) | Position + stacking. `z-index: 10500` deliberately sits above the highest modal/overlay layer (currently 10000). |

### The invariants

1. **Home is always reachable.** The home icon in the top-left breadcrumb bar must remain clickable on every authenticated user-dashboard route. No overlay, modal, drawer, theater mode, or loading state may visually cover or `pointer-events: none` it.
2. **`z-index` ceiling for overlays is 10000.** The breadcrumb sits at `z-index: 10500`. Any new full-viewport modal, backdrop, or fixed overlay must stay strictly below 10500. If a future flow legitimately needs to *prevent* navigation (mid-upload, mid-payment, mid-checkout), add a `.breadcrumb-bar--locked` modifier on the breadcrumb (which dims it and disables `pointer-events`) — don't bump a modal above it.
3. **Breadcrumb backdrop is intentional.** The translucent dark background + `backdrop-filter: blur(6px)` on `.breadcrumb-bar` exists so the icons stay legible when the breadcrumb floats over a modal backdrop (e.g. `.vt-backdrop` theater mode, `.mad-confirm-overlay`, `.restart-dialog-overlay`). Don't remove it without replacing with another contrast guarantee.
4. **Mobile.** No breakpoint hides the breadcrumb. The mobile bottom tab bar (`NavBar`) carries a redundant Home tile as a second escape hatch.

### Adding a new overlay — checklist
- [ ] Its CSS `z-index` is `< 10500`.
- [ ] It has its own close affordance (X button, Esc handler, click-outside).
- [ ] Visually verified that the breadcrumb bar still reads cleanly when this overlay is open (the backdrop blur + tint should handle it).
- [ ] If the overlay is "blocking" (e.g. mid-upload), the breadcrumb is dimmed via `.breadcrumb-bar--locked` while the operation is in flight — never by raising the overlay above it.

## Transcription (whisper.cpp)

### What it does
Extracts audio from uploaded video (ffmpeg-static) and transcribes it with whisper.cpp
(`whisper-cli`) on the Metal GPU. Produces the operator-facing transcript outputs (txt / srt /
vtt / segment-level JSON) plus an **additive word-level timing sidecar** for downstream
products that need word timecodes.

### Key files and entry points
| File | Role |
|------|------|
| `lib/services/media-processor.ts` | ffmpeg extract + whisper spawn. `runWhisper` does the primary run (unchanged outputs) then an additive word-level pass. |
| `lib/services/transcripter-service.ts` | Queue/worker. `enqueue()` → `processNext()` → `MediaProcessor.process()`. Reads worker count + timeout live per job. |
| `lib/services/transcription-config.ts` | Resolves model / workers / timeout from admin Settings (env-var → Setting → default). Single source of validation. |
| `lib/store/lpos-settings-store.ts` | SQLite `lpos_settings` KV. Transcription keys + `TRANSCRIPTION_MODEL_OPTIONS`. `base` is the fallback default. |
| `lib/services/runtime-dependencies.ts` | Resolves whisper binary + model dir (`runtime/whisper-models/`). |
| `app/api/admin/transcription-config/route.ts` | Admin GET/PUT for model, workers, timeout. Reports which model files are installed. |
| `components/settings/TranscriptionConfigCard.tsx` | Admin Settings UI card (model dropdown, workers, timeout + length-aware toggle). |

### Model selection
Configured in admin **Settings → Transcription (Whisper)** (SQLite-backed, no redeploy). Options:
- `base` — fast, lower accuracy. **Fallback default** — behavior is unchanged until an admin opts up.
- `large-v3-turbo` — **recommended.** Near large-v3 accuracy at a fraction of the runtime.
- `large-v3` — highest accuracy, slowest.

Precedence: `LPOS_WHISPER_MODEL` env var → admin Setting → `base`. An unknown/typo'd stored
value falls back to `base` rather than selecting a missing model file. Each model requires
`runtime/whisper-models/ggml-<name>.bin` to be present.

### Word-level timing sidecar (additive)
The primary whisper run (`-oj -otxt -osrt -ovtt`) is untouched — the Transcripts UI enumerates
`.txt` and reads `.txt/.json/.srt/.vtt/.meta.json`, so nothing there changes. A **second** whisper
invocation runs with `-ml 1 -sow` (max-len 1 char + split-on-word → one JSON entry per word, each
with `offsets.{from,to}` in ms) and writes `<jobId>.words.json`. That filename does not end in
`.txt/.srt/.vtt`, so the UI never surfaces it. The word pass is best-effort: if it fails, the
primary transcript still succeeds. (`-ml 1 -sow` was chosen over `-ojf -dtw <model>` because `-dtw`
needs a compiled alignment-heads preset whose name must exactly match the model — a mismatch aborts
the run — whereas `-ml 1 -sow` is model-agnostic and reuses the existing JSON shape. Tradeoff:
timing is decode-derived, slightly looser than DTW.)

### Workers & timeout (ops)
Both configurable in the same Settings card (live per job, no restart):
- **Workers** — default 2. For `large-v3` / `large-v3-turbo` set to **1**: concurrent jobs contend
  for the single Metal GPU and slow each other down. Env override: `LPOS_TRANSCRIPTION_WORKERS`.
- **Per-job timeout** — default 15 min. The old fixed 15-min cap trips on >30–45 min videos under
  large models. Enable **"Scale timeout with video length"** so the timeout scales with media
  duration (≈4× real-time + 5-min overhead, capped at 6 h); the configured minutes act as a floor.
  Duration is passed from the retranscribe route (`asset.duration`); the fresh-upload path probes
  duration asynchronously so it falls back to the fixed floor there.

### Downloading a model file (manual step)
Model binaries are gitignored (`runtime/whisper-models/**`) and live only on the host machine.
Download `large-v3-turbo` (~1.6 GB) from the official whisper.cpp HuggingFace repo into the
**production tree's** model dir:

```bash
curl -L -o /Users/lpos/lp-app-ecosystem/lpos-dashboard/runtime/whisper-models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

For highest accuracy also fetch `ggml-large-v3.bin` (~3.1 GB) from the same repo. After the file
lands, select the model in Settings — the card shows a "NOT INSTALLED" warning until it exists.

### Current status / known gaps
- Word-level sidecar is written but not yet consumed by any downstream product (separate effort).
- Fresh-upload path does not pass duration to the length-aware timeout (duration is probed in
  parallel); only the manual retranscribe path is length-aware today.

## Build / Version Tag

### What it does
Displays a tiny build identifier in the very top-left corner of every page: `<major>.<minor>.<patch> · <short-sha>` (e.g. `0.1.77 · 1a3dd50`). `major.minor` come from `package.json.version` and are bumped manually when something user-noticeable ships. `patch` auto-increments as commits land on top of the last version-field bump — no manual bookkeeping required. The short SHA pinpoints the exact build. Clicking the chip copies the full 40-char SHA so we can `git checkout <sha>` to recover the precise code state — useful when chasing user-reported regressions or recovering lost code.

### Scheme: hybrid semver
- **Major / Minor.** Edit the `version` field in `package.json` (e.g. `0.1.0` → `0.2.0`) and commit. The patch resets to 0 at that commit because the version-field-change commit becomes the new anchor.
- **Patch.** Auto-computed at server start as the number of commits since the last commit whose diff contained the `"version":` line in `package.json`. (`git log -1 --format=%H -G '^[ \t]*"version":' -- package.json` finds the anchor; `git rev-list --count <anchor>..HEAD` is the patch.)
- **You cannot forget to bump.** Patch advances automatically on every commit. Only major/minor require human attention, and only when *you* think something deserves a minor/major bump.

### Bumping minor or major — checklist
1. Edit `package.json`: change the `version` field (e.g. `0.1.0` → `0.2.0`).
2. Commit the change (e.g. `LPOS_COMMIT_OK=1 git commit -m "Bump version to 0.2.0"`).
3. After the next server restart the chip reads `0.2.0 · <sha>`. Subsequent commits become `0.2.1`, `0.2.2`, …

### Key files
| File | Role |
|------|------|
| `lib/version.ts` | Server-side helper. Reads git via `execSync` once at module load and caches. Returns `{ count, sha, shaShort, branch, dirty, date, display }`. Falls back to `v.dev` if git is unavailable. |
| `app/layout.tsx` | Calls `getAppVersion()` and passes the result to `AppShell` as a prop. |
| `components/shell/AppShell.tsx` | Renders `<VersionTag />` in both the home and inner layouts. |
| `components/shell/VersionTag.tsx` | Client component. Renders the chip; click-to-copy SHA via `navigator.clipboard`. Tooltip shows full SHA + branch + commit date. |
| `app/globals.css` (`.version-tag`) | Fixed `top:4px left:8px`, 10px monospace, dim until hover. Sits above the breadcrumb bar (`top:20px left:32px`) and clear of the navbar pill (centered) and the right-side bell/menu/gear stack. |

### When it refreshes
On server restart. The git lookup runs once at module load (cached in a module-level variable). After a `git commit` and `git pull` the next `npm start` cycle picks up the new count and SHA.

### Dirty marker
If the working tree had uncommitted changes when the server started, an asterisk appears (`0.1.28* · 7755ccb`) — a hint that the running build doesn't match a tagged commit.

## Google Drive Folder Provisioning

### What it does
Every project needs a Drive folder tree — `/LPOS/{clientName}/{projectName}/{Scripts,Transcripts,Assets,Workbooks}` in the Shared Team Drive — for the Assets tab to have somewhere to resolve to. Folder IDs are **not** stored on the project row; they live in `data/drive-folders.json`, keyed by `{clientName}/{projectName}`. The Assets tab does **not** lazily create folders on open, so provisioning must happen at project-creation time.

### Key files and entry points
| File | Role |
|------|------|
| `lib/services/drive-folder-service.ts` | `setupProjectDriveFolders(project)` is **the single shared entry point** every creation path must call. It ensures the LPOS root, ensures the per-project tree, and adopts any pre-existing orphaned Drive folder. Idempotent; returns `{ status: 'created' \| 'existing' \| 'skipped' \| 'error' }`. |
| `app/api/projects/route.ts` | Direct project creation — calls `setupProjectDriveFolders` after `store.create()`. |
| `app/api/prospects/[prospectId]/promote/route.ts` | Prospect promotion — auto-creates a project in both branches (fold-into-existing-client and new-standalone-client) and calls `setupProjectDriveFolders` on each, so promoted clients get the same tree as directly created ones. |
| `app/api/admin/drive/backfill/route.ts` | `POST` — runs `ensureAllProjectFolders()` over every project. Idempotent one-time check/repair; returns a per-project audit (`created` / `existing` / `skipped` / `failed`). |
| `components/settings/DriveSettingsClient.tsx` | Settings → Drive UI. "Check / Create All Project Folders" button triggers the backfill and shows the created/already-set-up/failed breakdown. |

### Data flow
Project created (direct OR promotion) → `setupProjectDriveFolders` → `ensureLposRootFolder` + `ensureProjectFolders` → folder IDs written to `drive-folders.json` → Assets tab resolves via `getCachedProjectFolders` / `resolveAssetsFolder`.

### Current status / known gaps
All creation paths (direct + both promotion branches) now provision folders through the shared helper. Historically the promotion path skipped this, leaving promoted clients without a folder tree; the admin backfill (Settings → Drive) is the one-time repair for any such pre-existing projects. If `GOOGLE_DRIVE_SHARED_DRIVE_ID` is unset, setup is a no-op (`skipped`).
