# Project History

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
