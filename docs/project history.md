# Project History

---

## 2026-04-02 — Theater mode defaults to comments open when comments exist

**User prompt:** When there are comments on a video, let's default to show those in theater mode instead of defaulting to collapsed

**Summary:** Changed `panelOpen` initial state in `VideoTheaterMode` from `false` to `comments.length > 0`.

**Files changed:**
- `lpos-dashboard/components/media/VideoTheaterMode.tsx` — `useState(false)` → `useState(comments.length > 0)` for `panelOpen`

**Decision rationale:** `comments` is available at mount time, so the initial state can be derived directly. No prop or effect needed.

---

## 2026-04-02 — Pause sidebar player when theater mode opens

**User prompt:** Can we make sure the sidebar player pauses when theater mode opens

**Summary:** Added `sidebarVideoRef` (a `useRef<HTMLVideoElement>`) and an `openTheater(src)` helper that pauses the ref before calling `setTheaterSrc`. Both theater mode buttons (Frame.io and local stream branches) now call `openTheater` instead of `setTheaterSrc` directly. The `ref` is attached to both `<video>` elements. The comment-click path that opens theater (`setTheaterSrc` at line ~769) is left unchanged — a seek-driven open doesn't require pausing.

**Files changed:**
- `lpos-dashboard/components/media/MediaDetailPanel.tsx` — added `sidebarVideoRef`, `openTheater()`, wired `ref` and `onClick` on both video branches

**Decision rationale:** Single ref is sufficient because only one video branch renders at a time (Frame.io or local, not both). `openTheater` keeps the pause + state update co-located so the order is guaranteed.

---

## 2026-04-02 — Revert sidebar player to native video + theater mode button below

**User prompt:** Revert to default player for sidebar and just add a theater mode button below it for now

**Summary:** Replaced `InlineVideoPlayer` in `MediaDetailPanel` with the native `<video controls>` element inside the existing `mad-video-wrap` container. Added a "Theater mode" button (`mad-action-btn`) below the video in a new `mad-video-theater-row` div. Removed the `InlineVideoPlayer` import (now unused in this file).

**Files changed:**
- `lpos-dashboard/components/media/MediaDetailPanel.tsx` — removed `InlineVideoPlayer` import; replaced both video branches with `mad-video-wrap` + native `<video>` + theater row button
- `lpos-dashboard/app/globals.css` — added `.mad-video-theater-row` rule

**Implementation summary:** Both the Frame.io stream and local stream branches now return a fragment containing the native video player and a `mad-video-theater-row` div with a `mad-action-btn` that calls `setTheaterSrc(src)`. The `mad-video-theater-row` uses `padding: 8px 18px 4px` to align the button with section content below.

**Decision rationale:** User wanted to simplify back to native controls while keeping theater mode accessible. Keeps `InlineVideoPlayer` intact in its own file for potential future reuse.

---

## 2026-04-02 — Sidebar player: apply missing aspect-ratio fix to ivp-video-wrap

**User prompt:** Dimensions are off on the sidebar player again. What happened there? / sure yes

**Summary:** History recorded that `aspect-ratio: 16/9` was added to `.ivp-video-wrap` in a prior session ("sidebar player not showing — CSS fix"), but the property was absent from the actual CSS. The comment on `.ivp-video-wrap` still read "16:9 ratio established by the video element itself," confirming the fix was logged but never landed. Applied the one-line fix.

**Files changed:**
- `lpos-dashboard/app/globals.css` — added `aspect-ratio: 16 / 9` to `.ivp-video-wrap`; updated comment

**Implementation summary:** Without `aspect-ratio` on the wrap, the container relied entirely on the child `<video aspect-ratio: 16/9>` for its height. When the video source errors before the box model resolves (proxy 401/404, Frame.io still processing), the video element may not contribute height, collapsing the wrap and the `ivp-error-overlay` to 0px — leaving only the controls bar visible. Adding `aspect-ratio: 16/9` to the wrap mirrors the old `mad-video-wrap { padding-top: 56.25% }` robustness: the container is always correctly sized regardless of video load state.

**Decision rationale:** Smallest possible fix. The diagnosis and intent were already documented; the code simply didn't match the history.

**Alternatives considered:** None — this was a straightforward re-application of the previously decided fix.

**Commands run:** None.

---

## 2026-04-01 (guest slate tab lock, script upload fix)

**Prompt:** Lock down guests in the studio tab — grey out all tabs except Presentation. Clean up UI. Upload box missing on project scripts page.

**Summary:** Three fixes. (1) Split `app/slate/page.tsx` into a thin server wrapper (reads session role) and `components/slate/SlatePageContent.tsx` (client component receiving `isGuest` prop). Guests default to the Presentation tab, hash-based tab init is skipped for guests, and all non-presentation tabs render with `.sl-pill--locked` (opacity 0.2, pointer-events none). (2) Fixed `app/projects/[projectId]/scripts/page.tsx` — it was using the read-only `AssetList` instead of `ScriptsTab`, so the upload drop-zone was never rendered. Switched to `<ScriptsTab projectId={projectId} />`. (3) Added `.sl-pill--locked` CSS rule to `globals.css`.

**Files changed:**
- `app/slate/page.tsx` — rewritten as server wrapper; passes `isGuest` prop
- `components/slate/SlatePageContent.tsx` — created; all former page.tsx client code + isGuest tab lock
- `app/projects/[projectId]/scripts/page.tsx` — swapped AssetList → ScriptsTab
- `app/globals.css` — added `.sl-pill--locked` style

**Decision rationale:** Server wrapper pattern injects session data into a client page without an extra client-side fetch. Slate content is unchanged beyond the isGuest prop and tab lock logic.

---

## 2026-04-01 (daily guest PIN, local network access, RBAC completion)

**Prompt (redacted — contains internal IP):** Implement daily rotating 4-digit guest PIN visible in admin settings; allow local network access at static LAN IP using that PIN; complete remaining PIN feature wiring (GuestPinCard, middleware public path, signin button href).

**Summary:** Completed the guest PIN system across all layers. Created `lib/services/guest-pin.ts` (HMAC-SHA256 deterministic PIN, no storage), `app/guest-pin/page.tsx` (4-box PIN entry UI), rewrote `app/api/auth/guest/route.ts` to POST + verify PIN, added `APP_LOCAL_URL` to `.env.local` and Socket.io CORS, created `components/settings/GuestPinCard.tsx` (server component displaying today's PIN), updated `app/settings/page.tsx` to include `GuestPinCard`, added `/guest-pin` to middleware public paths, and changed the signin page guest button href from `/api/auth/guest` to `/guest-pin`. Also completed the full RBAC session shape change (role in JWT), admin management UI + API, guest home screen with Presentation/Script Upload tiles, path allow-list enforcement in middleware, join links for pre-authorized device flow, and `/slate#presentation` hash-based tab deep-link.

**Files changed:**
- `lib/services/guest-pin.ts` — created; daily HMAC PIN
- `app/guest-pin/page.tsx` — created; 4-digit PIN entry UI
- `app/api/auth/guest/route.ts` — rewritten to POST + PIN verification
- `components/settings/GuestPinCard.tsx` — created; admin-only PIN display
- `app/settings/page.tsx` — imports and renders GuestPinCard
- `middleware.ts` — `/guest-pin` added to public path list; Socket.io CORS updated
- `app/signin/page.tsx` — guest button href → `/guest-pin`
- `server.ts` — Socket.io CORS allows `APP_LOCAL_URL` alongside `APP_BASE_URL`
- `.env.local` — added `APP_LOCAL_URL=http://172.20.10.137:3000`
- `lib/models/user.ts` — added `UserRole` type
- `lib/store/admin-store.ts` — created; bootstrap admin + persistent admins.json
- `lib/services/session-auth.ts` — role added to session payload
- `lib/services/api-auth.ts` — created; `requireRole()` helper
- `app/api/auth/google/callback/route.ts` — assigns role from admin-store on login
- `app/api/admin/admins/route.ts` — created; GET/POST/DELETE admin management
- `app/api/admin/restart/route.ts` — replaced hardcoded email check with requireRole
- `app/api/storage/config/route.ts` — added requireRole('admin') to PUT
- `app/api/projects/[projectId]/media/route.ts` — file extension allowlist, 415 on reject
- `lib/services/ingest-queue-service.ts` — removed global stale sweep guard
- `components/settings/AdminsPanel.tsx` — created; admin list management UI
- `app/guest/page.tsx` — created; guest home with Presentation + Script Upload tiles
- `app/guest/scripts/page.tsx` — created; project picker for script upload
- `app/api/auth/join/presentation/route.ts` — created; pre-authorized device join link
- `app/api/auth/join/scripts/[projectId]/route.ts` — created; pre-authorized device join link
- `app/slate/page.tsx` — hash-based tab deep-link on mount
- `lib/services/frameio-tokens.ts` — AES-256-GCM encryption at rest
- `docs/credential-rotation-runbook.md` — created

**Decision rationale:** PIN is HMAC-derived (no storage, no DB, no race conditions) — same PIN re-derived on every call until midnight UTC. Local IP access uses same app stack; no separate server needed. GuestPinCard is a server component so the PIN is never sent as a prop to the client.

**Assumptions / follow-ups:** Error message audit (plain-English API errors across all routes) is still pending.

---

## 2026-04-01 (sidebar player not showing — CSS fix)

**Prompt:** "Let's try option A first."

**Summary:** Added `aspect-ratio: 16 / 9` to `.ivp-video-wrap` in `globals.css`. The wrap previously had no explicit height and relied entirely on the child `<video aspect-ratio: 16/9>` to establish its dimensions. When the video source fails or hasn't loaded yet, the video element may not contribute height, collapsing the wrap to 0px and making both the error overlay and video area invisible. Setting `aspect-ratio` on the wrap itself makes it self-sufficient.

**Files changed:**
- `app/globals.css` — added `aspect-ratio: 16 / 9` to `.ivp-video-wrap`

**Decision rationale:** Mirrors the robustness of the old `.mad-video-wrap { padding-top: 56.25% }` pattern — the container always has correct dimensions regardless of the video element's load state. One-line fix, no component changes needed.

---

## 2026-04-01 (sidebar player not showing — diagnosis)

**Prompt:** "Please inspect the sidebar player and determine why it is not showing."

**Summary:** Analysis-only task. No files changed. Identified two distinct root causes for the sidebar player (`InlineVideoPlayer` in `MediaDetailPanel`) appearing absent:

1. **Primary cause — no source available**: The rendering IIFE at `MediaDetailPanel.tsx:545–587` returns `null` when both `asset.frameio.assetId` and `asset.filePath` are falsy. This is by design — there is nothing to stream — but produces a silent absence with no error indicator. Affects registered-type assets before Frame.io upload, and any asset where `filePath` is null.

2. **Previously fixed regression** (also 2026-04-01 entry below): The `setUnavailable(true)` early-return with a zero-height `ivp-unavail` div caused the player to pop in briefly and then vanish. That fix is correctly applied in the current code.

3. **Residual CSS fragility (low risk)**: `.ivp-video-wrap` has no `aspect-ratio` of its own and relies on the child `<video aspect-ratio: 16/9>` to establish its height. If the video element fails to establish height (e.g., source errors before box model resolves), the wrap collapses and the error overlay is also 0px, leaving only the controls bar visible.

**Files changed:** None.

**Decision rationale:** No code change warranted without confirming which scenario the user is experiencing. The fix for scenario 2 is already live. Scenario 1 is intentional but could benefit from a visible placeholder when no source is available.

**Follow-ups / open questions:** Should there be a "no preview available — upload to Frame.io to enable streaming" placeholder shown when neither `frameio.assetId` nor `filePath` is set? Currently the section is completely absent.

---

## 2026-04-01 (InlineVideoPlayer error-overlay fix)

**Prompt:** "I can see it pop in for half a second and then disappear again. Something is blocking this"

**Summary:** Fixed a regression where the inline video player in the media sidebar would briefly appear then vanish. Root cause: `onError` fired on the `<video>` element when the frameio-stream proxy returned a non-video response (401/404). This triggered `setUnavailable(true)`, which caused an early return that replaced the entire player with a standalone `ivp-unavail` div. That div had no inherent height in its context, so it appeared invisible.

**Fix:** Removed the early-return `ivp-unavail` pattern entirely. The full player structure (`ivp-root`, `ivp-video-wrap`, controls) now always renders. When `unavailable = true`, an `ivp-error-overlay` div with `position: absolute; inset: 0` overlays the video area, keeping the player dimensions (provided by `<video>` with `aspect-ratio: 16/9`) and controls bar intact.

**Files changed:**
- `components/media/InlineVideoPlayer.tsx` — removed early-return block; added conditional overlay inside `ivp-video-wrap`
- `app/globals.css` — replaced `.ivp-unavail` with `.ivp-error-overlay` (absolute overlay pattern)

**Decision rationale:** Keeping the video element in the DOM at all times means dimensions are always established by the `<video>` element's `aspect-ratio: 16/9`. An overlay approach is robust against proxy errors, auth failures, and Frame.io processing delays — the player chrome stays visible regardless of stream availability.

**Alternatives considered:** Giving `ivp-unavail` an explicit fixed height — rejected because it's fragile and loses the player controls. Hiding the `<video>` with `visibility: hidden` when unavailable — unnecessary since the video renders behind the overlay anyway.

---

## 2026-03-31 (large-file upload timeout fix)

**Prompt:** Uploads getting stuck waiting. Follow-up: file is 9 GB — largest attempted so far.

**Summary:** Root cause identified as Node.js 18+'s default `requestTimeout` of 300,000 ms (5 minutes). The custom HTTP/HTTPS server in `server.ts` inherits this default, which terminates the connection mid-stream for large uploads before the route handler finishes writing to disk. A 9 GB file at even modest speeds (30 MB/s) exceeds the 5-minute window. The ingest job is created as `queued` via pre-reservation but the connection drop prevents the `file` event from completing, leaving it permanently stuck. Fix: set `httpServer.requestTimeout = 0` (disabled) immediately after server creation. Application-level timeouts (the stale-sweep 10-minute failsafe) remain in place. Not related to any recent code changes — first time this file size was attempted.

**Files changed:**
- `server.ts` — `httpServer.requestTimeout = 0` after server creation

**Decision rationale:** `requestTimeout = 0` is appropriate for a local/on-prem server with trusted clients. The stale-sweep handles genuinely abandoned jobs. A hard transport-layer cutoff at 5 minutes is the wrong place to enforce timeouts for media ingest.

---

## 2026-03-31 (project back button + client routing)

**Prompt:** Add a back button near the project header to navigate from a project back to the projects list, matching the style of the existing back button on the projects page. Also fix routing so Client View → Projects View → Project is preserved end-to-end (currently the client context is lost when navigating back from a project).

**Summary:**
1. **Back button in project header** — Added a `proj-back-btn` chevron button to `ProjectDetail` to the left of the client name/project name block. Navigates to `/projects?client={clientName}` if client context is available, otherwise `/projects`.
2. **Client context in URL** — `handleProjectClick` in `projects/page.tsx` now appends `?client={clientName}` to the project URL so the client is embedded in the navigation. On the projects page, a `useEffect` reads `?client=` from `useSearchParams` on mount and restores `activeClient`, so back-navigating from a project lands correctly in the client's project list rather than the top-level client selector.
3. **CSS** — `project-header` set to `display: flex; align-items: flex-start; gap: 12px` to accommodate the button alongside the text block.

**Files changed:**
- `app/projects/page.tsx` — Added `useEffect`, `useSearchParams`; restore `activeClient` from URL on mount; include `?client=` when navigating to a project
- `components/projects/ProjectDetail.tsx` — Added `useRouter`; read `client` from searchParams; added back button to project header; wrapped text content in a div
- `app/globals.css` — `project-header` flex layout

**Decision rationale:** Storing client in the URL query param is the least-invasive approach — no global state, no localStorage, works correctly with browser back/forward. The `useEffect` restore on the projects page handles the case where the user arrives at `/projects?client=X` from any navigation source.

---

## 2026-03-31 (transcript tab sort + filter)

**Prompt:** Can we quickly add sort and filter on transcript tab in a project?

**Summary:** Added a filename filter input and sort selector to the Transcripts tab toolbar. Filter narrows the visible list by filename substring (case-insensitive). Sort options: Newest first (default), Oldest first, Name A–Z, Name Z–A. "Select all" and bulk actions operate on the filtered/sorted list. Empty-filter state shows a contextual message.

**Files changed:**
- `components/projects/ProjectDetail.tsx` — `filterText`/`sortKey` state; `displayedTranscripts` memo; updated `toggleSelectAll`; filter input + sort select in toolbar; list renders `displayedTranscripts`
- `app/globals.css` — `.proj-transcript-filter-row`, `.proj-transcript-filter-input`, `.proj-transcript-sort-select`

**Decision rationale:** Pure client-side — no API changes needed since all transcripts are already fetched. Default sort is newest-first to match expected usage pattern.

---

## 2026-03-31 (follow-up — share migration + bug fix)

**Prompt:** (1) Confirmed share links are asset-scoped and won't update when versions are added. Asked whether we can detect assets in existing shares, add the new stack entity to those shares, then remove the original file — so existing links automatically reflect new versions. (2) Screenshot showed 9 separate files in Frame.io (3 versions × 3 videos) instead of 3 version stacks — stack creation wasn't working.

**Summary:**
1. **Bug fix — `getAsset` called after `registerAsset`**: The prior Frame.io file ID was always null because `getAsset` was called after the new version was already registered as current. Moved the lookup to before `registerAsset` so the correct v1 Frame.io IDs are captured.
2. **Share migration on stack creation**: After creating a version stack (v1→v2), `runUpload` now scans `getAllShareAssets` for any shares containing the old file ID, adds the new stack ID to each (`addFilesToShare`), removes the old file ID (`removeFileFromShare`), and updates the local store. All previously-sent share links automatically resolve to the stack (and therefore always serve the head version). Migration only runs on the `createVersionStack` path — for v3+ (`addFileToVersionStack` path), shares already reference the stack.

**Files changed:**
- `app/api/projects/[projectId]/media/route.ts` — moved `getAsset` call before `registerAsset`; removed duplicate post-registration lookup
- `lib/services/frameio-upload.ts` — added `addFilesToShare`, `removeFileFromShare` imports from frameio; added `getAllShareAssets`, `addShareAssets`, `removeShareAsset` imports from share store; share migration loop inside `createVersionStack` branch

**Decision rationale:** Share migration is non-fatal (wrapped in its own try/catch) so a Frame.io API hiccup doesn't block the upload. The migration only applies on first stacking — v3+ uploads already have shares pointing at the stack, which auto-serves the latest version.

---

**Prompt:** Two issues: (1) On v2+ uploads with skip transcription, the UI shows the asset as "Not Transcribed" even though a v1 transcript exists. Should instead show transcription status from v1 with a subtle indicator that it came from a prior version. (2) When uploading a v2, LPOS reflects the new upload but versioning does not happen in Frame.io — a brand-new Frame.io asset is created instead of versioning the existing one. Requested: make v2 overwrite the old one in Frame.io (version stack). Frame.io API reference provided at developer.adobe.com/frameio.

**Summary:**
Implemented both fixes.
1. **Transcription version fallback + v1 badge**: `pickLatestTranscription` now falls back to the most recent transcription across any version when the current version has no transcription record. `bundleToProjection` sets `fromPriorVersion: true` and `sourceVersionNumber` when the transcription belongs to an older version. The UI shows a subtle `v{n}` pill badge alongside the transcription status badge when `fromPriorVersion` is true.
2. **Frame.io version stacking**: Two new functions added to `frameio.ts` — `createVersionStack` (POST `.../version_stacks`) and `addFileToVersionStack` (PATCH `.../files/{id}/move`). The upload route captures the prior version's Frame.io file ID and stack ID before registering a new version and passes them as context to `triggerFrameIOUpload`. After the S3 upload completes, `runUpload` either creates a new stack (first replacement) or moves the file into the existing stack (subsequent replacements). The stack ID is stored in `frameio.stackId` and the stack's `view_url` replaces the review link so all existing shares resolve to the latest version.

**Files changed:**
- `lib/models/media-asset.ts` — Added `fromPriorVersion`, `sourceVersionNumber` to `TranscriptionInfo`; added `stackId` to `FrameIOInfo` and `defaultFrameIO()`
- `lib/store/canonical-asset-store.ts` — `pickLatestTranscription` fallback; `bundleToProjection` sets `fromPriorVersion`, `sourceVersionNumber`, `stackId`
- `lib/services/frameio.ts` — Added `createVersionStack()` and `addFileToVersionStack()`
- `lib/services/frameio-upload.ts` — Extended `FrameIOUploadContext` with `priorFrameioFileId`/`priorFrameioStackId`; version stack logic post-upload
- `app/api/projects/[projectId]/media/route.ts` — Imports `getAsset`; captures prior Frame.io IDs before new version registration; passes them to `triggerFrameIOUpload`
- `components/media/MediaDetailPanel.tsx` — Wrapped status badge in `.mad-tx-status-group`; added `.mad-tx-version-pill` badge
- `app/globals.css` — Added `.mad-tx-status-group` and `.mad-tx-version-pill` styles

**Decision rationale:** Transcription fallback is the minimal-touch fix — no DB migration, no new columns, just a looser query in `pickLatestTranscription`. The `fromPriorVersion` flag is set at projection time (not stored) so it's always accurate. For Frame.io versioning, the Frame.io v4 API uses a two-step flow (upload file → create/extend version stack) rather than a single versioning endpoint; this is the canonical workflow per their developer docs. The `stackId` is persisted in `metadata_json` (already spread via `...patch.frameio`) so no schema migration is needed.

**Alternatives considered:** For transcription, could have shown "Transcribed (prior version)" as a text label change rather than a pill badge — chose the pill to keep the existing status badge unchanged and legible. For Frame.io, could have tracked the stack type as a string enum on the model; opted for `stackId: string | null` (presence = stack exists) to keep it simple.

---

## 2026-03-27

**Prompt:** Multiple items — (1) "We do need a way to clear cancelled jobs from queue page" + button UI cleanup; (2) investigation of cancel-override bug ("when reached by the queue, the cancel is overridden and the ingestion starts, and then they get stuck at 95%"); (3) stale queued job sweep false positives ("Upload never started — browser may have left the page" firing on healthy queued jobs).

**Summary:**
1. **Batch-aware stale sweep** — Added `batch_id` column to `ingest_jobs`. `reserveIngestJobs` stamps all jobs in a multi-file batch with a shared UUID. Sweep now only fails batched jobs if no sibling in the batch has started uploading (`temp_path IS NOT NULL`), preventing false positives when large files take >10 min to upload sequentially.
2. **Cancel-override fix** — `isCancelled()` was in-memory only; after a server restart/hot-reload the Set was empty and cancelled jobs would be re-ingested. Now falls back to a DB status check so cancels survive restarts.
3. **Queue page clear button styling** — Restyled `queue-clear-btn` to match `queue-filter-select` (same background, border-radius 6px, padding 5px 10px, font-size 0.8rem).

**Files changed:**
- `lib/store/ingest-queue-db.ts` — `batch_id TEXT` column migration + index
- `lib/services/ingest-queue-service.ts` — `IngestJob`/`IngestJobRow` types, `add()` signature, `isCancelled()` DB fallback, `sweepStaleQueuedJobs` batch-aware filter
- `app/api/projects/[projectId]/ingest-queue/reserve/route.ts` — generates batch UUID, passes to `add()`
- `app/globals.css` — restyled `queue-clear-btn`

**Decision rationale:** Batch ID is the cleanest discriminator between "legitimately waiting in a sequential loop" and "abandoned after page refresh" — the only two states a queued-no-temppath job can be in. DB fallback in `isCancelled` is a one-liner that closes the restart/hot-reload gap with no performance cost (PK lookup).

**Commands/tests run:** Code review only.

---

## 2026-03-26 (second entry)

**Prompt:** "Ok let's actually just remove it from the navbar. I think going through pipeline is fine for now."

**Summary:** Removed Queue link from the navbar entirely; cleaned up the unused `--utility` CSS modifier.

**Files changed:**
- `components/shell/NavBar.tsx`
- `app/globals.css`

**Implementation summary:** Removed the `navbar-sep` + Queue `<Link>` from NavBar. Removed the `.navbar-link--utility` CSS block added in the previous entry. Queue is now only reachable via the pipeline tray's "View queue" / "View full queue" link.

**Decision rationale:** Pipeline tray always provides the queue link contextually; a navbar entry adds clutter without adding access.

**Commands/tests run:** Code review only.

---

## 2026-03-26

**Prompt:** "Currently queue is accessible via the pipeline and a tab in the main dropdown menu. I was hoping to preserve the main dropdown for top-level navigation (Home, Projects, Media), but if there's no better way to keep queue accessible, then let's at least separate it from slate with a divider."

**Summary:** Separated Queue from Studio in the navbar pill with a visual divider, and visually de-emphasised it with a `--utility` modifier so it reads as secondary navigation without being removed.

**Files changed:**
- `components/shell/NavBar.tsx`
- `app/globals.css`

**Implementation summary:**

Replaced the `toolNav.map()` loop with explicit renders of the Studio and Queue links, inserting a `navbar-sep` between them. Added `navbar-link--utility` modifier to the Queue link: slightly smaller font (0.76rem vs 0.84rem), lighter weight (500 vs 600), and more muted colour (42% opacity vs 70%) — same hover/active behaviour, just visually subordinate. Active state uses `var(--accent)` at lower background opacity than primary links.

**Decision rationale:** The Queue link stays in the navbar for discoverability (it's not accessible any other way if the pipeline tray is empty), but the `--utility` style distinguishes it clearly from the primary nav items (Home, Projects, Media, Studio) without needing a separate UI surface. The `navbar-sep` divider matches the existing separator pattern between the home icon and main links.

**Alternatives considered:**
- Moving Queue exclusively to the pipeline tray (not accessible when nothing is running — bad for reviewing history)
- Making it a user menu item (buried, wrong mental model)

**Commands/tests run:** Code review only.

---

## 2026-03-25 (ninth entry)

**Prompt:** "Ok let's look at the cancel behavior. When clicked on an asset, it shows canceled and greys out. But, when reached by the queue, the cancel is overridden and the ingestion starts. And then they get stuck at 95%."

**Summary:** Fixed three-layer cancel override bug: cancelled ingest jobs were being un-cancelled by the streaming progress updater, the route had no early-exit for cancelled jobs, and the post-write cancel branch left the job stuck at `ingesting 95%`.

**Files changed:**
- `lib/services/ingest-queue-service.ts`
- `app/api/projects/[projectId]/media/route.ts`
- `components/projects/MediaTab.tsx`

**Root cause analysis:**

The cancel bug had three compounding causes:

1. **`setProgress()` overwrote cancelled status** — `UPDATE ingest_jobs SET status = 'ingesting'` had no WHERE guard on current status. The first data chunk from the upload would unconditionally flip a `cancelled` job back to `ingesting`, making it visually reappear as active.

2. **No early rejection in the route** — When a pre-reserved job ID arrived via `x-ingest-job-id`, the route had no check before entering the streaming Promise. It would begin piping the entire file through busboy before discovering (after the full write) that the job was cancelled.

3. **Post-write cancel branch didn't restore status** — The `isCancelled` check in `out.on('finish')` deleted the file and called `res()` but never updated the DB. By that point `setProgress()` had set the job to `ingesting 95%`, and it stayed there indefinitely — never completing, never marked cancelled.

**Implementation summary:**

1. **`setProgress()` guard** — Added early return if the job is already `cancelled`, `done`, or `failed`. Also added `AND status NOT IN ('cancelled', 'done', 'failed')` to the SQL UPDATE as a second line of defence, so concurrent calls can't race past the in-memory check.

2. **Early route rejection** — After resolving `pendingJobId`, check `isCancelled(preReservedJobId)` before the streaming Promise. Returns `{ uploads: [] }` immediately so the browser doesn't upload bytes that will be discarded.

3. **Post-write cancel status restore** — In the `isCancelled` branch of `out.on('finish')`, call `ingestQueue.cancel(jobId)` after deleting the temp file, so the DB is restored to `cancelled` even if `setProgress()` had already flipped it to `ingesting`.

4. **Client-side skip** — In the `uploadFiles()` loop, check `ingestJobs` state for each reserved job before sending the XHR. If the job is already `cancelled` in the client's view, skip the file entirely. This avoids even initiating the request — the server-side guard is the authoritative check, but this saves bandwidth.

**Decision rationale:** All four fixes are necessary: (1) stops the visual override, (2) stops wasted bytes on the wire, (3) ensures clean terminal state regardless of streaming timing, (4) is a best-effort client guard that improves UX when the cancel has already been confirmed by the socket.

**Commands/tests run:** Code review only.

**Assumptions / follow-ups:**
- `cancel()` being called a second time in fix 3 is idempotent — it re-adds to `cancelledIds` (Set) and re-applies the DB update. Activity record will be logged twice in the edge case where streaming completed before cancel was processed; acceptable.

---

## 2026-03-25 (eighth entry)

**Prompt:** "Clean up this UI. The clear canceled (and I'm assuming the clear failed) look atrocious. Need it to be similar to the rest of our menu buttons."

**Summary:** Styled the "Clear failed" and "Clear cancelled" queue header buttons to match the app's design language; fixed header vertical alignment.

**Files changed:**
- `app/globals.css`
- `components/queue/QueueView.tsx`

**Implementation summary:**

1. **Added `.queue-clear-btn` CSS** — small ghost button matching the `.tt-clear-btn` pattern used elsewhere: `background: none`, `border: 1px solid var(--line)`, `border-radius: 4px`, muted text color, `0.72rem` font size, transitions on color and border-color. Hover lifts to `var(--text)` / `var(--line-strong)`.

2. **Added `.queue-clear-btn--danger` modifier** — hover-only danger tint (`#e07070` text, reddish border) for the "Clear failed" button. Matches the `sh-card-action-btn--danger` pattern.

3. **Fixed `.queue-header` alignment** — changed `align-items: baseline` to `align-items: center` so buttons sit flush with the pill badges rather than aligning on text baseline.

4. **Fixed `.queue-summary` alignment** — added `align-items: center` to the flex row.

5. **Updated JSX class names** — both buttons now use the shared `queue-clear-btn` class; the failed button additionally carries `queue-clear-btn--danger`.

**Decision rationale:** Shared class with a modifier keeps the CSS DRY and consistent with the rest of the app's button patterns.

**Alternatives considered:** None — pure styling fix.

**Commands/tests run:** Code review only.

---

## 2026-03-25 (seventh entry)

**Prompt:** "We do need a way to clear cancelled jobs from queue page."

**Summary:** Added a context-driven "Clear X cancelled" button to the pipeline queue page header, mirroring the existing "Clear failed" pattern.

**Files changed:**
- `lib/services/pipeline-tracker-service.ts`
- `hooks/usePipelineQueue.ts`
- `components/queue/QueueView.tsx`

**Implementation summary:**

1. **`clearCancelled()` on `PipelineTrackerService`** — mirrors `clearFailed()` exactly; iterates the in-memory pipelines map, removes entries with `overallStatus === 'cancelled'` from the pipelines map plus both indices (`jobIndex`, `assetIndex`), then broadcasts.

2. **`clearCancelled` socket event** — added `socket.on('clearCancelled', ...)` listener alongside the existing `clearFailed` listener in `start()`.

3. **`clearCancelled` in `usePipelineQueue`** — added `useCallback` emitting `'clearCancelled'` socket event; included in hook return.

4. **"Clear cancelled" button in `QueueView`** — added `totalCancelled` count derived from `pipelines.filter(p => p.overallStatus === 'cancelled').length`; button appears in the header summary bar only when `totalCancelled > 0`, same conditional pattern as "Clear failed".

**Decision rationale:** Direct mirror of the clearFailed pattern — no new patterns introduced. Server-side removal prevents cleared entries reappearing on reconnect.

**Alternatives considered:** None — the pattern was already established.

**Commands/tests run:** Code review only.

---

## 2026-03-25 (sixth entry)

**Prompt:** "Or, and tell me if this isn't possible, uploading somehow becomes server-side? If it's dependent on the browser being undisturbed, then could we somehow queue those files not so fragily? The super simple solution is to just prompt the user to confirm when they're refreshing or leaving the page, right? 'Incomplete uploads will be cancelled' or something like that. Regardless, we need to have some system that clears out stale queued waiting uploads from the queue because that's annoying."

**Summary:** Added a `beforeunload` confirmation prompt to guard against accidental page navigations during active uploads, and a server-side stale queued job sweep to auto-fail orphaned pre-reserved jobs.

**Files changed:**
- `components/projects/MediaTab.tsx`
- `lib/services/ingest-queue-service.ts`

**Implementation summary:**

1. **`beforeunload` warning (`MediaTab.tsx`)** — Wrapped the upload loop in a `try/finally` block. At the start of `uploadFiles()`, a `beforeunload` handler is registered that calls `e.preventDefault()` and sets `e.returnValue = ''`, triggering the browser's native "Leave site?" confirmation dialog. The handler is removed in `finally` so it never fires after all uploads complete normally. This is the standard cross-browser pattern; the actual message text is controlled by the browser and cannot be customised.

2. **Stale queued job sweep (`ingest-queue-service.ts`)** — Added `STALE_QUEUED_AFTER_MS = 10 min` and `STALE_SWEEP_INTERVAL_MS = 2 min` constants. Added a `sweepStaleQueuedJobs()` private method that:
   - Short-circuits if any job is currently `ingesting` (queued jobs are legitimately waiting in that case)
   - Queries for `queued` jobs with `temp_path IS NULL` (upload never began) older than 10 minutes
   - Bulk-updates them to `failed` with error message "Upload never started — browser may have left the page"
   - Broadcasts the updated queue
   Added `start()` calls: once at boot, then on a 2-minute `setInterval`. Added `stop()` method to clear the timer on graceful shutdown.

**Decision rationale:** The `beforeunload` guard is the simplest possible safeguard with zero server changes — it only activates when the function is running (uploads in flight) and cleans itself up automatically. The stale sweep targets only the specific failure mode: pre-reserved jobs whose uploads never began (no `temp_path`), not legitimately-queued jobs waiting behind an active ingest. The `ingesting` guard prevents the sweep from falsely failing queued jobs that are legitimately waiting their turn.

**Alternatives considered:**
- Server-side upload (resumable/TUS): would make uploads page-refresh-safe but is a major architectural change — deferred.
- Client-side stale detection: would require the client to be connected; server-side sweep handles the case where the client never reconnects.

**Commands/tests run:** Code review only.

**Assumptions / follow-ups:**
- Browser `beforeunload` dialogs are suppressible in some contexts (e.g. Electron, certain automation). This is acceptable for a web dashboard.
- The 10-minute stale threshold assumes a single file upload that stalled for any reason. Very large batches pre-reserved but not started within 10 minutes would also be swept — acceptable trade-off since the user would have visibly left or crashed.

---

## 2026-03-25 (fifth entry)

**Prompt:** "Ok. This all works fine now, it just takes forever. Super slow. Any ideas on what could be done to increase speed?"

**Summary:** Four targeted performance improvements to the ingest and pipeline pipeline.

**Files changed:**
- `app/api/projects/[projectId]/media/route.ts`
- `lib/services/storage-volume-service.ts`
- `lib/services/frameio.ts`
- `lib/services/transcripter-service.ts`

**Implementation summary:**

1. **In-stream SHA256 hashing (`route.ts`)** — Previously, after writing the file to disk, the route awaited `computeFileHashAsync(dest)` which read the entire file a second time to compute its hash for duplicate detection. This doubled disk I/O and blocked the HTTP response (and therefore the next file's upload). Fix: attach a `createHash('sha256')` to the existing `stream.on('data')` handler so the hash is computed as bytes flow in during the write. By `out.on('finish')`, `hash.digest('hex')` is instant. Removed `computeFileHashAsync` import and call entirely.

2. **Storage volume decision cache (`storage-volume-service.ts`)** — `resolveProjectMediaStorageDir()` called `getStorageAllocationDecision()` on every request, which synchronously probed all 24 Windows drive letters via `fs.existsSync` + `fs.accessSync` + `fs.statfsSync`. Fix: added a module-level cache with 60 s TTL. Cache is only populated when an active volume exists (so error states re-probe immediately). Added `invalidateStorageCache()` export; called when `resolveProjectMediaStorageDir` finds no active volume.

3. **Parallel S3 chunk uploads (`frameio.ts`)** — Frame.io presigned S3 URLs were uploaded in a sequential `for` loop, serialising what is an inherently parallel operation. Fix: precomputed byte offsets for all parts, then uploaded in batches of 4 concurrent `PUT` requests via `Promise.all`. Cancel check runs between batches.

4. **Concurrent transcription workers (`transcripter-service.ts`)** — Only one whisper.cpp process ran at a time via `isProcessing: boolean`. On a multi-core machine this left CPU idle while one file transcribed. Fix: replaced the single flag with `activeProcessors: Map<string, MediaProcessor>` (jobId → processor). `MAX_WORKERS` defaults to 2, overridable via `LPOS_TRANSCRIPTION_WORKERS` env var. `processNext()` now dequeues a new job whenever `activeProcessors.size < MAX_WORKERS`. All cancel/abort/stop paths updated to use the map.

**Decision rationale:** In-stream hashing was the highest-priority fix because it blocked the critical path (HTTP response, hence next file starting). Storage caching was minimal effort with immediate benefit. S3 parallelism improves Frame.io throughput proportionally to chunk count. Transcription concurrency is the largest absolute time saving for multi-file batches but depends on CPU headroom.

**Commands/tests run:** Code review only.

**Assumptions / follow-ups:**
- `LPOS_TRANSCRIPTION_WORKERS=1` can be set to restore serial behaviour on constrained hardware.
- Frame.io `CHUNK_CONCURRENCY=4` is conservative; could be raised if network allows.

---

## 2026-03-25 (fourth entry)

**Prompt:** "Ok, I like it. Can we make it so? And one more element... a better clearing method for the queue page. Even just a context-driven 'Clear failed' button at the top"

**Summary:** Implemented all four deferred UI improvements plus the "Clear failed" button.

**Files changed:**
- `components/projects/MediaTab.tsx`
- `hooks/usePipelineQueue.ts`
- `components/queue/QueueView.tsx`
- `lib/services/pipeline-tracker-service.ts`
- `app/api/pipeline/entries/route.ts` (created)

**Implementation summary:**

1. **Removed media tab progress bar** — stripped `uploadProgress`, `uploadLabel` state and all their setters; removed the `remoteIngesting`/`remoteProgress`/`remoteLabel`/`showUploadProgress`/`displayProgress`/`displayLabel` derived state block; removed the progress bar JSX from the drop zone. Drop zone now always shows its normal state; `uploading` flag still disables the click target to prevent double-submit. Simplified `uploadFile` signature by removing unused `current`/`total` params.

2. **Asset sort by pipeline activity** — added `activeIngestByFilename` map (keyed by filename, from `activeIngestJobs`). After the user-chosen sort, assets with active ingest jobs float to the top, sorted among themselves by descending progress. Remaining assets keep user-chosen order.

3. **Queue page instant load** — created `GET /api/pipeline/entries` REST endpoint that returns the current `PipelineTrackerService.getEntries()` snapshot synchronously. `usePipelineQueue` now fires a `fetch` on mount before the socket connects, so the page renders with data immediately; socket keeps it live.

4. **Collapsible pipeline entries** — `QueueEntry` in `QueueView.tsx` now has a collapsed state; clicking the header row toggles stages visibility. Terminal entries (complete/failed/cancelled) default to collapsed; active entries default to expanded.

5. **"Clear failed" button** — context-driven button in the queue header: visible only when `totalFailed > 0`. Emits `clearFailed` socket event handled by `PipelineTrackerService.clearFailed()`, which removes all `failed`/`partial_failure` entries from in-memory state and broadcasts the updated list. `usePipelineQueue` exposes the `clearFailed` callback.

**Decision rationale:** Client-side removal from the tracker's in-memory map is sufficient — the server already purges old entries after 30 minutes. Emitting via socket (rather than a REST DELETE) keeps the action consistent with how retry/cancel work.

**Alternatives considered:** Client-side clearing only (without server notification) — rejected because cleared entries would reappear on reconnect/navigation.

**Commands/tests run:** Code review only.

---

## 2026-03-25 (third entry)

**Prompt:** *(paraphrased)* 5 follow-up issues: (1) remove media tab progress bar — let pipeline/queue handle it; (2) sort assets by pipeline progress; (3) queue page opens slowly (2–4s); (4) waiting/queued assets should not be considered stalled; (5) auto-fail fires on healthy queued assets. Also: pipeline entries should be collapsible.

**Summary:** Fixed the critical bug causing queued ingest jobs to be auto-failed. Planned the remaining UI improvements for a follow-up pass.

**Files changed:**
- `lib/services/pipeline-tracker-service.ts`

**Implementation summary:**

The `tick()` method in `PipelineTrackerService` evaluated stall detection and the 2× auto-fail threshold against `stage.updatedAt` for *all* non-terminal stages — including `queued` ones. Since `updatedAt` is set at job creation, a file waiting in the queue for longer than 4 minutes (2 × 2-minute ingest stall threshold) would be auto-failed with "Auto-failed: exceeded maximum allowed time." Added an explicit `stage.status === 'queued'` guard that skips stall/auto-fail logic and clears any previously-set `stalled` flag, then `continue`s to the next stage. Stall/timeout now only fires once a stage has actually started (status transitions past `queued`).

**Decision rationale:** The queued/waiting state has no concept of "stalled" — a stage is stalled only if it has started and stopped making progress. Queued stages are simply waiting for their predecessor to finish; the wait time is unbounded and expected. The fix is a single guard with no behavioural change for active stages.

**Alternatives considered:** Raising the hard timeout threshold — rejected because it would only delay the problem, not fix it. Resetting `updatedAt` on status transitions — also valid, but the guard approach is more explicit and self-documenting.

**Commands/tests run:** Code review only.

**Planned (deferred) items:**
1. **Remove media tab upload progress bar** — `showUploadProgress` / `remoteIngesting` display in the drop zone. Replace with subtle busy state (disable click) while the IngestTray handles visible progress. Affects `MediaTab.tsx` display logic and derived state.
2. **Sort assets by pipeline activity** — Float assets with active ingest jobs (from `ingestJobs`) to the top of the MediaTab asset list, sorted by descending ingest progress. Implement as a pre-sort step before the user's chosen sort. May extend to pipeline stages later.
3. **Queue page load performance** — `usePipelineQueue` waits for the `/pipeline` Socket.io `pipelines` event before rendering data (blank for 2–4s). Fix: add a `GET /api/queue/pipelines` REST endpoint that returns current pipeline state immediately; the hook fetches it on mount and then stays live via the socket. Alternatively, the socket server emits on connect (it already does, `socket.emit('pipelines', ...)`), so the delay may be in the `getEntries()` computation or socket handshake. Profile first.
4. **Collapsible pipeline entries** — `QueueEntry` in `QueueView.tsx` should be collapsible (click header to toggle stages visibility). Default: collapsed for terminal entries, expanded for active.

**Assumptions / follow-ups:**
- With the stall fix applied, currently-queued jobs should now survive the wait and proceed to ingest normally.
- Items 1–4 above are UI-only and can be done in any order.

---

## 2026-03-25 (second entry)

**Prompt:** I'm still not seeing the queued second file in the queue page before it's active. That's a problem.

**Summary:** Added pre-reservation of ingest queue entries so all files in a batch are visible as "queued" in the IngestTray before any upload begins.

**Files changed:**
- `components/projects/MediaTab.tsx`
- `app/api/projects/[projectId]/media/route.ts`
- `app/api/projects/[projectId]/ingest-queue/reserve/route.ts` (created)

**Implementation summary:**

Added a `reserveIngestJobs(filenames)` helper to `MediaTab.tsx` that calls the new `POST /api/projects/:id/ingest-queue/reserve` endpoint before the upload loop starts. The endpoint creates all ingest jobs at once in `queued` status, which triggers Socket.io broadcasts so all files appear in the IngestTray immediately. Each call to `uploadFile` now accepts an optional `reservedJobId` parameter and sends it via the `x-ingest-job-id` request header. The server-side `media/route.ts` reads that header first; if present it uses the pre-reserved job ID directly instead of creating a new one, avoiding duplicates. The `x-upload-filename` path remains as fallback for the single-file case (no reservation needed) and for any non-browser callers.

**Decision rationale:** Pre-reserving all jobs in a single request before the sequential upload loop is the simplest way to make all queued files visible simultaneously. The alternative (creating jobs one at a time at the start of each upload iteration) would still leave later files invisible until their turn.

**Alternatives considered:**
- Parallelising uploads — would require rethinking the per-file progress label and version-confirmation UX; deferred.
- Server-side batching (one multipart request with all files) — much larger change; deferred.

**Commands/tests run:** Code review only.

**Assumptions / follow-ups:**
- Version-confirmation retry does not pass `reservedJobId`; the first attempt will have already failed or consumed the reserved job, so the retry lets the server create a fresh job.
- If the reserve request fails (network error, service unavailable), `reserveIngestJobs` returns `[]` and the upload loop falls back to the `x-upload-filename` path — only the active file will be visible at a time.

---

## 2026-03-25

**Prompt:** Our upload process is broken. 1. Ingesting does not open the pipeline tray until the first asset reaches "100%" in the media tab progress bar. I don't know why that is - the pipeline tray should open as soon as ingesting starts. 2. When the tray opens, it gets stuck at 95% and then stalls. [RangeError: The value of "length" is out of range. It must be >= 0 && <= 2147483647. Received 2218176955] { code: 'ERR_OUT_OF_RANGE' }

**Summary:** Fixed two upload pipeline bugs: tray not opening until 100% XHR progress, and large-file RangeError causing the ingest job to stall at 95%.

**Files changed:**
- `components/projects/MediaTab.tsx`
- `app/api/projects/[projectId]/media/route.ts`

**Implementation summary:**

**Bug 1 — Tray opens too late:** The ingest job was created inside `bb.on('file', ...)`, which fires only after busboy has started parsing the body. When the full body arrives as one buffered chunk (common for large files on a fast local network), the route handler doesn't fire the `file` event until all bytes are received — i.e., at 100% XHR progress. The fix: the client now sends the filename in an `x-upload-filename` request header, and the server creates the ingest job immediately when the POST request is received (before the Promise / busboy setup). This makes the IngestTray open as soon as the upload starts. If the header is absent (old clients, other callers), the route falls back to creating the job in `bb.on('file', ...)` as before.

**Bug 2 — RangeError / 95% stall:** The specific file in the report was ~2.07 GB (content-length = 2 218 176 955 bytes). Node.js buffers are capped at 2 147 483 647 bytes (INT32_MAX). When the body arrived pre-buffered as a single chunk and was handed to busboy via `Readable.fromWeb(req.body).pipe(bb)`, busboy internally called `Buffer.from(chunk)` on the full-body chunk, triggering `ERR_OUT_OF_RANGE`. This unhandled exception in a stream callback bubbled up as an `uncaughtException`, crashing the server and leaving the ingest job stranded at 95% (the cap value). The fix: `req.body` is now piped through a `TransformStream` that splits any chunk into ≤ 64 KB slices before it reaches busboy. This is a no-op for normal chunk sizes and a safety valve for any chunk that exceeds the limit.

Additional hardening: added `nodeStream.on('error', ...)` to catch stream errors gracefully, cleaned up the pending job in `bb.on('error', ...)` and `bb.on('finish', ...)` if no file field was received.

**Decision rationale:** Sending filename in a header is the minimal client change that gives the server a filename before the multipart body is parsed. The `TransformStream` chunk splitter is the simplest fix for the RangeError that requires no dependency changes and is transparent to the rest of the pipeline.

**Alternatives considered:**
- Handling the upload outside Next.js (in the custom server) to avoid potential body buffering — more invasive, deferred.
- Adding `busboy` limits config — not sufficient; the error is in Node.js's buffer layer, not busboy's size limits.

**Commands/tests run:** Code review only; no automated test suite run.

**Assumptions / follow-ups:**
- If files > 2 GB are regularly uploaded and need to be sent to Frame.io without compression, verify that the `COMPRESS_THRESHOLD_BYTES` (1.9 GB) in `frameio-compress.ts` is still correct.
- The 95% cap in ingest progress (`Math.min(95, ...)`) is intentional — it leaves headroom for post-stream processing. No change needed there.
