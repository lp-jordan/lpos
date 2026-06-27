# Project History

---

## 2026-06-09 — People prospect-stage "No stage" silently reverts — PATCH route's `str()` helper ignored `null`

**Timestamp:** 2026-06-09T22:05:00Z

**User prompt (verbatim):**
> Changing the Stage for a people entry back to Not Set doesn't save. It reverts to the last set stage

**Response summary:** Traced the bug to the prospects PATCH route's field-coercion helper. The inline `ProspectStageBadge` on the person detail page sends `{ prospectStage: value || null }` when the user picks the empty "No stage" option, so the request body becomes `{ prospectStage: null }`. The route's `str()` helper at `app/api/prospects/[prospectId]/route.ts:48` only handled string inputs — `typeof null === 'object'`, so it returned `undefined`, the field got dropped from the patch, the DB never updated, and the page re-rendered with the stale value (the "reverts to last set stage" symptom). Updated `str()` to treat `null` as an explicit clear (mirroring how `""` and the existing `num()` helper already behave) and hardened the `status` check to use a direct `typeof body.status === 'string'` test so the new `null` branch can't accidentally NULL out the non-nullable `status` column.

**Files changed:**
- `app/api/prospects/[prospectId]/route.ts` — `str()` helper now returns `null` when the body field is `null` (was `undefined`), so clear-via-null PATCHes apply. `status` check switched from `str('status') !== undefined` to `typeof body.status === 'string'` to preserve the non-nullable contract independently of `str()`. Added inline comment explaining the regression class.

**Implementation summary:**
- One real change of behavior: any of the ~14 `str()`-gated fields (`source`, `referredBy`, `prospectStage`, `accountModel`, `revenueType`, `expansionPotential`, `expectedStartMonth`, `owner`, `startMonth`, `recurringBillingStatus`, `renewalDate`, `firstRecurringBillDate`, `activeServices`, `nextFilmDate`) can now be cleared by sending `null` as well as `""`. Previously only `""` worked and `null` silently no-op'd.
- The new `str()` is:
  ```ts
  const str = (k: string) => {
    const v = body[k];
    if (v === null) return null;
    if (typeof v === 'string') return v || null;
    return undefined;
  };
  ```
- The `status` field is the only non-nullable string in the patch surface. Without the special-case it would inherit the new "null clears" semantic and a stray `{ status: null }` from any future caller would NULL out the column. Kept it inert by checking `typeof body.status === 'string'` directly — same effective behavior as before this change.

**Decision rationale:**
- **Fix at the API layer (not the frontend):** The bug surfaces from one specific call site (the inline stage picker) but the underlying contract was inconsistent — `""` cleared, `null` was ignored. The `num()` helper sitting right next to `str()` already handled `null` correctly, so this was clearly an oversight rather than a deliberate asymmetry. Patching the API normalizes the contract for every current and future caller (the in-tree edit-form path at `PersonDetailClient.tsx:333` has the same `value || null` pattern for many fields), instead of leaving a footgun for the next person to step on.
- **Special-case status instead of widening the str() return type:** `status` is the only non-nullable field that flows through `str()`. A one-line direct `typeof` check is cheaper than threading "nullable vs not" through the helper, and it makes the constraint visible at the call site.

**Alternatives considered:**
- **Frontend-only fix** — change `prospectStage: value || null` to `prospectStage: value` in `ProspectStageBadge` (and the equivalent at `PersonDetailClient.tsx:333` for every clearable field). Smaller diff but leaves the API contract broken; would silently re-emerge the next time anyone added a clearable field and reached for `null` as the obvious "no value" wire shape.
- **Reject `null` in the API with a 400** — strict but punishes a reasonable wire shape; the helper is meant to coerce, not validate.

**Commands/checks:**
- `grep` over `app/`, `components/`, `lib/` for `prospectStage` / `prospect_stage` to enumerate read and write paths.
- Read `app/people/[personId]/PersonDetailClient.tsx` (badge component) and `app/api/prospects/[prospectId]/route.ts` (PATCH handler) to confirm the call chain.
- Read `lib/models/prospect.ts` to confirm which fields are nullable (only `status` is not).
- No automated tests run — single-line helper change with explicit inline comment.

**Assumptions / follow-ups:**
- The in-tree full edit-form save path at `PersonDetailClient.tsx:333` also uses `field || null` for clearable fields and would have had the same bug for every other clearable field — those are now silently fixed too. Worth a quick manual sanity-check on one of them (e.g. clearing "Owner") if there's any doubt, but the helper change is the only path involved.
- No project-history entry exists for the original introduction of `prospectStage`, so no cross-link to add.

---

## 2026-06-09 — Asset move: keep historical activity events at the source

**Timestamp:** 2026-06-09T21:20:00Z

**User prompt (verbatim):**
> Yeah I think we can keep historical events at the source, and then just record post-move events to the new location. Make sense? Where would users even see this original vs new location history?

**Response summary:** Answered the "where do users see this" question — today the activity-events UI surface is sparse: dashboard ActivityStrip (global top-6 task bucket), dashboard ActivityHistoryModal (paginated global feed with optional per-project filter / search / bucket tabs), and MediaTab's "Latest comments" sort (indirect, no UI). No per-project activity tab or per-asset activity panel exists yet. Then changed the asset-move behavior: historical `activity_events` for moved assets stay at the SOURCE project (the rewrite-project_id step is dropped); the `asset.moved` event still anchors at the TARGET; future activity on the asset naturally lands at the target because the asset's project_id is now the target.

**Files changed:**
- `lib/store/asset-move-store.ts` — dropped the `activity_events.project_id` rewrite. Removed `getActivityDb` import and the per-asset `withTransaction(activityDb, …)` block. Updated the file-level docstring to describe the new "history stays at the source, arrival anchors at the target" model and to note that future activity inherits the asset's new project_id naturally.
- `app/api/projects/[projectId]/media/move/route.ts` — docstring updated to match: target project gets one `asset.moved` event per successful move; source's historical events are intentionally untouched. Code path was already correct (the route always wrote the move event at `project_id: toProjectId`); only the prose was stale.

**Implementation summary:**
- Behavior change is one helper: the move route was always writing the move event at the target. The only thing that changed at the data layer is dropping the `UPDATE activity_events SET project_id = ? WHERE asset_id = ? AND project_id = ?` statement in the per-asset loop of `moveAssetsBetweenProjects`.
- Net read of activity per project after this change:
  - **Source project's feed:** Shows the asset's full pre-move history. No asset.moved event. After the move the asset just stops appearing — honest reflection of "it left here at this time, here's what came before".
  - **Target project's feed:** Starts with the asset.moved event ("Asset moved from {fromName} to {toName}"). All subsequent activity on the asset (re-transcribes, comments, deliveries, etc.) naturally lands here because the asset's project_id is now this project.
- The "honest split" is intentional — and aligned with how editors think about the move: the asset's pre-move story belongs to the project it was filmed/edited under; the post-move chapter belongs to the new home.

**Decision rationale:**
- **Drop the rewrite (vs. keep it + add an outbound counterpart event):** The user explicitly preferred this model. It's also simpler — no extra event row per move, no third DB touched, no source-side audit anchor to maintain. The cost is the absence of an "asset.moved (outbound)" marker at the source's tail, but the asset disappearing from the source's asset list IS the marker (and the move event at the target carries the from-project info in its `details_json` for cross-referencing).
- **Don't add a per-project activity tab in this commit:** The user asked about the surface as part of the question, not as a feature request. The current surfaces handle the read fine for now; a per-project activity tab is the obvious follow-up if/when the user wants it (the API endpoint already exists at `/api/projects/[projectId]/activity` — just unused).

**Alternatives considered:**
- **Record a parallel outbound `asset.moved` event at the source** (`project_id: fromProjectId` with the same `details_json`). Cleaner audit trail at the cost of doubling the per-move event count. Declined to match the user's instruction; can be added as a one-line `recordActivity` call if they reconsider.
- **Keep the historical rewrite but ALSO write a source-side event:** maximally redundant; not what was asked.

**Commands/checks:**
- Tracing: ran an Explore agent over the full UI to confirm there's no per-project activity tab today before recommending the model. Findings included in the response that preceded the implementation.
- Grep verified that `getActivityDb` is no longer used in `asset-move-store.ts` after the import was removed.
- Working tree showed only the two intended files modified before the commit.

**Assumptions / follow-ups:**
- If/when a per-project activity tab is built (the `/api/projects/[projectId]/activity` route already exists), this asymmetry will become user-visible — the SOURCE project's tab will show pre-move events with the asset name but no record of where the asset went; the TARGET project's tab will start with the move event. Both reads are correct; if "explain where the asset went" is desired on the source side, adding the outbound parallel event is a one-liner.
- `getActivityDb` is still imported and used by the activity-monitor-service itself and by other consumers — only the unused import in `asset-move-store.ts` was removed.

---

## 2026-06-09 — Follow-up tweaks: conditional Referred-by, prospect/client visual stripe, asset right-click move, + Tab modal, auto-Tab-1, tab delete confirm

**Timestamp:** 2026-06-09T20:55:00Z

**User prompt (verbatim — 6-tweak follow-up to today's batch):**
> - Only show referred by if there is a value in "source" in people page. Otherwise hide that new field.
> - Maybe we remove the dedicated prospect badge and instead differentiate the way prospect vs. active client cards look so it's more visual. Thoughts here?
> - Let's expose Move to Project in the right click menu on an asset as well.
> - Let's change + day to + Tab in production notes. I'd rather use a custom modal as well, not system default. Let's also move this add button right justified and in-line with the hide log, select, and export csv buttons.
> - On first new tab creation for a project, let's put all existing notes into a default "Tab 1". So the tabs should then be "All", "Tab 1", "[Newly created & Named Tab]", etc. Understand?
> - We need a confirmation modal for delete on a tab.

**Response summary:** All six landed in one batch. Replaced the prospect/client text badge with a left-edge color stripe on cards/rows (amber/green/muted). Hid Referred-by when Source is empty (display-time gates on persisted value; edit-time gates on live state so the row appears/disappears as the user changes Source mid-edit). Added Move-to-project to the asset right-click menu — with desktop-style "act on multi-select if the right-clicked asset is part of it, else single-asset" semantics. Renamed "+ Day" to "+ Tab", replaced `window.prompt` with a custom modal, moved the button into the log-controls row right-justified. Server-side auto-creates a "Tab 1" + reassigns existing untagged notes when the first tab is created on a non-empty project (with a one-time targeted ack to the originating socket so it auto-activates the user's freshly-named tab). Replaced the inline ✓/× tab-delete affordance with the shared ConfirmModal.

**Files changed:**
- `lib/services/slate-service.ts` — `createSlateTab` handler now: (1) detects first-tab + existing-notes case, creates a `Tab 1` row, bulk-assigns every tagless note's `tabId` to it, persists the migrated notes file, and emits an additional `notesReloaded` broadcast so all clients render the migration in one frame; (2) creates the user-named tab as before; (3) emits a targeted `slateTabCreatedAck` to the originating socket carrying the new tab's id so the originator's UI can auto-activate it.
- `hooks/useSlate.ts` — handles the new `slateTabCreatedAck` event by calling `setActiveSlateTabIdState(payload.id)` directly. Notes about localStorage reconciliation in the comment block (the ack fires from inside a socket effect that doesn't carry the latest `currentProjectId` closure, so the next setActiveSlateTab call from the UI handles persistence). Drive-by comment on the existing `notesReloaded` handler now also documents the first-tab-migration case.
- `components/slate/SlatePageContent.tsx` —
  - `ConfirmModal` import added.
  - New state: `confirmDeleteTab` (id/name pair driving the delete-confirm modal), `showAddTabModal`, `addTabValue`. Removed the old `pendingDeleteTabId` state.
  - Film-day bar visibility tightened to `slateTabs.length > 0` only (the "+ Tab" entry moved out of the bar, so a no-tabs-yet bar would just be empty). When tabs exist, the bar starts with the synthetic "All" pill.
  - Inline ✓/× delete flow replaced with a single 🗑 button that opens the shared `ConfirmModal`. Body explains that notes will move back to Unassigned; danger styling; on confirm calls `deleteSlateTab` + clears the active tab if it was the deleted one.
  - "+ Day" prompt button removed from the bar. New "+ Tab" button added to the `sl-log-controls` row with `marginLeft: 'auto'` so it sits inline with Hide Log / Select / Export CSV but right-justified. Defaults its initial value to `Tab <slateTabs.length + 1>`.
  - New inline "Add film-day tab" modal: input + Cancel/Add buttons; Enter submits, Escape closes. When `slateTabs.length === 0 && notes.length > 0` it shows a one-line preview note explaining that existing notes will be moved into a new Tab 1 — so the migration isn't a surprise.
  - New tab-delete `ConfirmModal` mounted at the bottom of the component alongside the existing modals.
- `components/prospects/NewPersonModal.tsx` — wrapped the Referred-by field in `{source && (…)}` so it only appears once a Source has been picked. Comment explains the rationale (an empty Source means there's nothing for the referrer field to elaborate on).
- `app/people/[personId]/PersonDetailClient.tsx` —
  - **Referred-by gating:** wrapped the Referred-by row in both the prospect and active-client branches of `AccountPanel`. Prospect branch gates on `editing ? source : person.source` so the row appears/disappears mid-edit as the user changes Source. Active-client branch gates on the persisted `person.source` (Source isn't editable in that layout).
  - **Header simplification:** removed the static "Prospect" pill from the prospects branch of the header — only the editable `ProspectStageBadge` remains. The Promote → button already carries the type signal more actionably, and the list-page stripe (see PeoplePageClient) does it for at-a-glance browsing. Dropped the now-unused `STATUS_LABELS` constant.
- `app/people/PeoplePageClient.tsx` —
  - **Visual stripe:** replaced the previous `StatusBadge` text-pill component + `STATUS_STYLE` map with a `STATUS_STRIPE` color map (`#f59e0b` / `#5ab95a` / `#777`) and a tiny `stripeBorderStyle(status)` helper that returns `{ borderLeft: '3px solid <color>' }`. Applied to both `PersonCard` and `PersonRow`'s root container style.
  - **Corner indicator simplified:** card and row no longer render the text badge. Active clients still show the `BillingBadge`; prospects still show the `StageBadge`; inactive shows nothing (the muted stripe says "inactive" by itself).
- `components/projects/MediaTab.tsx` —
  - `showMoveModal` state type changed from `boolean` to `{ assetIds: string[] } | null` so the modal can be invoked with either the multi-select set (from the bulk bar) or a single right-clicked asset (from the context menu).
  - Bulk-bar button now passes `{ assetIds: [...selectedIds] }`.
  - New context menu entry "Move to project…" with desktop semantics: if the right-clicked asset is in the active selection and the selection > 1, act on the full set; otherwise act on the single asset.
  - New `IconMove` SVG def (building outline) added next to the existing icon components.
  - `MoveAssetsModal` invocation now reads `selectedCount` and `selectedAssetIds` from the state object so it works for both flows.

**Implementation summary:**
- The first-tab auto-Tab-1 migration runs entirely server-side inside the existing `createSlateTab` handler — single round trip, no client awareness of the migration logic needed. The notes file is rewritten in the same handler, the broadcast covers the new tabs + the reassigned notes in two events, and the originating socket gets one extra targeted ack so its UI auto-activates the user's named tab. Other connected clients see the new tabs + reassigned notes but stay on whatever tab they were on (no surprise jumps).
- The conditional Referred-by uses **the live source state during edit** so the row materializes as the user picks a Source for the first time and disappears if they clear it back to "—". Display-time it just gates on the persisted `person.source`. This is implemented with `{(editing ? source : person.source) && (…)}` in the prospect branch; the active-client branch reuses the persisted-only check since the Source field isn't editable there.
- The visual stripe is implemented as an inline `borderLeft` style rather than a CSS class to keep the change to a single file (no `.css` module edit). The colors come from the same palette used by the prospect-stage badge family so the people page reads as visually consistent. A possible follow-up is promoting these to CSS custom properties on `:root` if we want to retheme.
- The right-click "act on multi-select if part of it, else single-asset" behavior matches what users expect from desktop file managers (Finder, Explorer, VS Code's file tree). It avoids the surprising "I right-clicked asset A but it moved all 5 selected ones including asset A" trap when A wasn't actually one of the selected.
- The `+ Tab` modal's preview hint (visible only when the project is in the pre-migration state) gives the user a chance to back out if they didn't expect the legacy-notes shuffle. The phrasing is intentionally non-scary ("will be moved into a new Tab 1 automatically") — this is a reversible operation (Tab 1 can be deleted and the notes flow back to Unassigned).

**Decision rationale:**
- **Stripe as left border vs full background tint or icon:** Left border carries the cue without taking horizontal space, doesn't compete with the existing card content, and is accessible at very small sizes. Background tint risks washing out the text; an icon would have to compete with the existing badges in the corner.
- **Drop the StatusBadge text entirely** (rather than keeping a small text-only label) — the stripe IS the type indicator, and the corner is now reserved for the *interesting* info (funnel stage or billing status). Stripe + corner-badge gives two distinct visual signals without redundancy.
- **First-tab auto-migration server-side, not "show a UI prompt":** The user explicitly said this should happen on first tab creation. Doing it server-side means it can't be skipped by a flaky client and the rest of the data model stays consistent without round-trip dependencies. The pre-create modal's preview hint covers the "did you know" UX angle.
- **`slateTabCreatedAck` targeted ack vs reusing the broadcast:** The broadcast is intentionally idempotent and stateless (replaces local tab list). Auto-activating the new tab is a per-originator concern — a targeted ack is the right scope. Other clients shouldn't jump tabs because someone else added one.
- **Right-click move semantics** — went with desktop convention (right-click in selection = act on selection, right-click outside = act on single) rather than always-single or always-selection, because either of those would break the user's mental model in different cases.

**Alternatives considered:**
- A toggle on the people-page list to "show type badge text" — declined; the stripe is sufficient and toggleable text would feel like an admission the visual cue isn't strong enough.
- Skipping the first-tab Tab-1 migration entirely and just letting the user manually assign old notes — declined; the user explicitly asked for the migration, and manually reassigning dozens of pre-tabs notes would be a chore.
- Showing the "+ Tab" button only when a project is loaded AND there are notes (to dovetail with the migration logic) — declined; the button should always work, the migration is automatic, and gating the button would feel arbitrary.
- A separate `SlateTabNameModal` component file instead of inlining the new-tab modal — declined for v1; the modal is ~50 lines and only used in one place. If it grows or shares state with another surface, extract.

**Commands/checks:**
- No dev server started (per [[feedback_never_start_dev_server]]).
- Grep verified no other call sites reference the removed `StatusBadge` / `STATUS_LABELS` / `pendingDeleteTabId` symbols.
- Bracket-counted the new `+ Tab` modal JSX manually — balanced; nested cleanly under the existing `</div>` closing the page root.

**Assumptions / follow-ups:**
- The list-page stripe colors are hard-coded inline; if we end up theming the dashboard later, moving them to CSS custom properties on `:root` would let us swap palettes without touching components. Not worth doing now.
- The first-tab migration is idempotent against the trigger (only runs when `tabs.length === 0`); if a user deletes all their tabs and creates a new one, the legacy-notes-now-orphaned notes would NOT be re-migrated. That's intentional — once they're tagged, they stay where the user put them.

---

## 2026-06-09 — Move assets between projects (LPOS-only, bulk action from Internal Media)

**Timestamp:** 2026-06-09T20:05:00Z

**User prompt (verbatim — item #4 of the 6-tweak batch):**
> Big one - The ability to move an asset or group of assets between projects. We'd want it to be clean - all records moving with the asset.

Clarification recorded earlier: Frame.io stays put on the FIO side; only LPOS records move. Banner-warning the editor about the FIO history-split before confirming.

**Response summary:** Added a "Move to project…" action to the Internal Media bulk-selection bar (existing multi-select infrastructure was already in place). The action opens a new `MoveAssetsModal` with a grouped project picker, search, and the FIO history-split warning. Confirm POSTs to a new `/api/projects/[projectId]/media/move` endpoint that runs a three-DB move helper: canonical-assets DB rewrites `assets.project_id`; core DB rewrites `asset_share_links.project_id` and detaches the asset from the old project's `deliverable_assets`; activity DB rewrites the asset's historical `activity_events.project_id` to the target so the new project's timeline shows the full asset history. The API records one `asset.moved` activity event per successful move, embedding the from-project / to-project info in `details_json` as the canonical audit anchor.

**Files changed:**
- `lib/store/asset-move-store.ts` — new. `moveAssetsBetweenProjects({ fromProjectId, toProjectId, assetIds })` returns `{ movedAssetIds, failedAssetIds }`. Per-asset: verifies `assets.project_id === fromProjectId` (fast-fail with reason text), then within per-DB transactions: canonical asset row updates `project_id`/`updated_at`; legacy `asset_share_links` UPDATE; `deliverable_assets` DELETE filtered to the source project's deliverables; `activity_events.project_id` rewrite. Child rows (asset_versions / media_files / distribution_records / editorial_links) follow implicitly because they reference asset_id, not project_id.
- `app/api/projects/[projectId]/media/move/route.ts` — new POST handler. Validates body shape, source ≠ target, both projects exist + target not archived. Calls the helper, then for each successful move records an `asset.moved` activity event scoped to the target project (with `from_project_*` and `to_project_*` in `details_json`). Response: `{ moved, failed }`.
- `components/projects/MoveAssetsModal.tsx` — new client modal. Fetches `/api/projects`, excludes the source + archived projects, groups by `clientName`, supports name/client filter search. Sticky FIO warning banner. Confirm calls the move endpoint, distinguishes "0 moved" (full failure → show reason) from partial-success (notify + propagate moved ids), and dismisses on full success. Returns moved ids to the parent so it can drop them from the selection set and refresh the local asset list.
- `components/projects/MediaTab.tsx` — added `showMoveModal` state; rendered a "Move to project…" action in the bulk-selection bar (positioned right before the destructive "Delete Files" button, with a building/house icon and a one-line tooltip). On `onMoved`, drops the moved ids from `selectedIds`, clears `selectedAsset` if it was among them, and re-runs `fetchAssets()` so the list reflects the move without a page reload.

**Implementation summary:**
- Multi-select was already wired in `MediaTab` (`selectedIds: Set<string>`, action bar, bulk handlers like delete / re-transcribe / publish) — the new button slots straight in. No new selection plumbing needed.
- Cross-DB move is per-asset, per-DB transactioned (not a single global transaction — three SQLite files = three connections). For v1 we accept that a crash mid-asset could leave a partial state; admin-initiated moves are rare enough that the simpler design is the right call. Per-asset failures are reported back individually so a partial batch still moves what it can.
- "Move + don't auto-add to target deliverable": deliverable membership is a project-scoped curation decision — the user usually wants to assemble a fresh delivery in the target. We drop the old `deliverable_assets` row to avoid stranded references, but don't fabricate one in the target.
- Historical `activity_events` rewrite is the spec'd "all records moving" answer. The audit chain stays intact because the new `asset.moved` event embeds the from/to in `details_json` — the source project still has THIS one event referencing the asset, and the target project has both the historical events (rewritten) AND the move event.
- FIO references on the asset (`frameio.assetId`, `stackId`, `playerUrl`, `reviewLink`, comments) are deliberately untouched — moving the asset on Frame.io is out of scope per spec. The modal banner makes this explicit before the user confirms.

**Decision rationale:**
- **Cross-DB sequential transactions** vs an attached-database transaction: SQLite supports cross-database transactions via `ATTACH`, but wiring the three connections that way would mean restructuring the existing single-DB store layout. Per-DB transactions are simple, atomic-per-DB, and the failure window is tiny.
- **Rewrite historical activity_events.project_id** over leaving them under the old project: spec said "all records moving with the asset." Leaving history under the source project would mean a moved asset's comment/upload/render history vanishes from the new project's activity feed — a real workflow regression.
- **Drop deliverable_assets, don't auto-link in target:** Auto-creating a target deliverable would make assumptions about the user's intent that they almost certainly don't want. The clean state is "asset has no deliverable link in either project"; user picks up from the new project's UI when they're ready.
- **Sticky banner warning vs require-checkbox-to-confirm:** Banner conveys the risk and keeps the modal one-click-to-confirm for the common case. A required checkbox would feel like seatbelt theater for a feature whose alt-flow is more confusing.
- **Per-asset failures returned individually:** preserves partial-success behavior. If 8 of 10 assets move and 2 fail, the 8 still relocate; the user sees a "Moved 8 of 10" message and the failed pair stays selected for retry.

**Alternatives considered:**
- Moving the Frame.io asset on Frame.io's side (via the FIO move API) — explicitly excluded per spec. Could be added later as an opt-in checkbox in the modal.
- Auto-linking the moved asset to a target-project deliverable when one with a matching name exists — too magical for v1; explicit re-assembly is cleaner.
- A worker queue for the move instead of in-process — overkill for a sub-second SQL operation; queue would only matter at a different scale.
- Recording one `asset.moved.batch` event per batch (one event covering N assets) instead of N events — declined; per-asset event makes the new project's activity feed show one row per moved item which matches the existing "asset.* event ↔ asset row" mental model.

**Commands/checks:**
- No dev server started (per [[feedback_never_start_dev_server]]).
- Verified `recordActivity` field shapes against `lib/models/activity.ts` after a first-draft used invalid `visibility: 'project_timeline'` (corrected to `'user_timeline'`) and JSON-stringified `details_json` (corrected to a plain object — the activity monitor stringifies internally).
- Grep verified the `MediaTab` `selectedIds` + bulk-action bar pattern was identical to existing bulk handlers (LeaderPass publish, Re-transcribe, Delete) — the new button followed that pattern.

**Assumptions / follow-ups:**
- Moving the Frame.io asset is the obvious next step if editors want a fully mirrored move. The infra for this would be a checkbox in the modal + a FIO move-asset call in the route handler.
- The historical-events rewrite is per-asset, looped — for a hypothetical massive move (hundreds of assets, tens of thousands of events) we'd want a batched UPDATE. v1's loop is fine for the practical batch sizes (1–20 assets at a time).
- The pre-commit hook on the repo prints the staged file list; verified once with `git diff --cached --name-only` before committing.

---

## 2026-06-09 — Film-day tabs on the Slate production notes panel

**Timestamp:** 2026-06-09T19:25:00Z

**User prompt (verbatim — item #5 of a 6-tweak batch):**
> A tab system on the studio page production notes to enable "film day" separation.

Clarification recorded earlier: fully manual ("+ Day" creates / drag-to-reorder / rename / delete) — no auto-detection from dates.

**Response summary:** Added a manual film-day tab system to the Slate `/slate` page's Production Notes panel. Each project owns an independent list of `SlateTab` rows persisted in a new `slate-tabs.json` file (sibling to the existing `slate-notes.json`). The notes panel now shows a horizontal pill bar above the note input — "All" + each named tab + "+ Day" button. Notes carry an optional `tabId`; when the user selects a specific tab the notes log filters to that day; the tab the note was added under is auto-tagged based on the active selection. Existing notes (pre-tabs) appear in "All" and stay visible.

**Files changed:**
- `lib/services/atem-utils.ts` — added optional `tabId?: string | null` to `SlateNote` and a new `SlateTab` interface (`id`, `name`, `sortOrder`, `createdAt`). The optional `tabId` is the only schema bump on the notes side — old `slate-notes.json` files load unchanged (undefined `tabId` reads as "Unassigned").
- `lib/services/slate-service.ts` — new `tabsPath` / `readTabs` / `writeTabs` helpers (mirror the existing notes file ops). `loadProject()` now also reads tabs; `projectLoadedPayload()` includes them. New socket events: `createSlateTab`, `renameSlateTab`, `reorderSlateTabs`, `deleteSlateTab`, `assignNoteToTab`. `addNote` now accepts an optional `tabId` from the client (and only persists it when it points at an existing tab — silently nulls stale/empty ids). Delete reassigns affected notes' `tabId` to null and emits a `notesReloaded` broadcast so all clients re-render in one shot.
- `hooks/useSlate.ts` — exposes `slateTabs` + `activeSlateTabId` state, with the active tab persisted per-project in `localStorage` (`lpos:slate:activeTab:<projectId>`). New socket handlers: `slateTabs` (single broadcast covering all CRUD), `notesReloaded` (full notes refresh after tab delete). Actions: `addNote` now automatically tags the new note with the active tab id; new `assignNoteToTab` / `createSlateTab` / `renameSlateTab` / `reorderSlateTabs` / `deleteSlateTab` / `setActiveSlateTab`.
- `components/slate/SlatePageContent.tsx` — new `sl-film-day-bar` above the note input on the Notes tab, only shown when a project is loaded. Per-tab UI: pill (click to activate, double-click to rename), and when active: ◂ / ▸ reorder arrows, ✎ rename, and 🗑 → confirm/cancel delete. "+ Day" button at the far right uses `window.prompt` to capture the new name (defaults to "Day N+1"). The existing notes log now filters the rendered list to the active tab (showing "No notes on this film day yet." when the day exists but is empty); All view shows every note. Filter happens BEFORE reverse so newest-in-tab still sits at the top, and the original `(note, originalIndex)` pair is threaded through the render so edit/delete/select still target the correct server index.

**Implementation summary:**
- Tabs persist in `data/projects/<projectId>/slate-tabs.json` — same sibling-file pattern as notes, no SQLite migration needed. The whole list is rewritten on every mutation (small array; not hot path).
- A single `slateTabs` broadcast covers create / rename / reorder / delete — the client just replaces local state with the server's authoritative list. Simpler than diff-patching and prevents drift between connected clients.
- The "All" pill is synthetic — it's `activeSlateTabId === null`. It shows every note regardless of `tabId`, and is the default after a tab delete (so the user isn't stranded on a tab that no longer exists).
- Notes inherit the active tab's id at creation time. The user doesn't have to think about it — open the "Day 2" tab, type, send.
- Tab delete never destroys notes. The server clears `tabId` on every affected note (in memory + file) and emits `notesReloaded` so the UI reflects the move-to-Unassigned without a refresh.
- Active tab persists per project in `localStorage` so reopening the same shoot re-lands on the same day.
- All the JSX restructuring around the notes log keeps the existing batch-select / edit / delete / CSV-export wiring intact: the `originalIndex` from the tuple list is what those handlers use, so the indices stay correct even when the visible list is filtered.

**Decision rationale:**
- **JSON file vs SQLite for tabs:** Slate already persists its notes as per-project JSON; staying in the same store keeps the deployment surface simple and lets a project be backed up / inspected / copied by trivially copying the project folder. The data is small and per-project — no relational queries warranted.
- **`tabId: string | null` (nullable column-style)** over a separate `tab_notes` junction: notes are 1:1 with tabs in this model — a note belongs to exactly one day. Null is the natural "Unassigned" state and reads cleanly in filters.
- **Single `slateTabs` broadcast** over a verb-per-action set (`tabCreated`, `tabRenamed`, …): the per-client handler reduces to one set-state call, and the server is the source of truth — no diff-patching to maintain.
- **Reorder = up/down arrows over drag-and-drop:** matches the [[editpanel_layout_and_design]] consistency note from the preprod board commit — the editor is occasional-use, arrows are accessible, no extra DnD library pull-in.
- **`window.prompt` for new-tab name:** the bar is already crowded with pills + active-tab affordances; a dedicated modal would feel heavy for a one-field input. Inline rename via double-click handles the most common edit case anyway.
- **Tab delete soft-nulls notes (never destroys):** consistent with the preprod column delete behavior — we don't lose user data on a misclick. The deleted tab's notes resurface in All, ready to be reassigned.

**Alternatives considered:**
- Auto-detect days from note timestamps (suggested in the earlier explore agent's notes) — declined explicitly per the user's "fully manual" answer.
- Drag-and-drop between tabs to reassign notes — deferred. The new `assignNoteToTab` server event is in place to support it later; for v1 the user moves notes manually by editing them after creation if needed.
- Storing tabs in `core-db.ts` SQLite — would add a v23 migration for a feature whose data already lives in the per-project JSON neighborhood. Net cost > value.

**Commands/checks:**
- No dev server started (per [[feedback_never_start_dev_server]]).
- Grep verified `useSlate` consumers (`SlatePageContent.tsx` is the only one) so the new state/actions don't break anything else.
- IIFE-around-the-map rewrite manually counted brackets — balanced.

**Assumptions / follow-ups:**
- The per-note `tabId` is intentionally optional — old notes load with `undefined` and behave the same as Unassigned. A future cleanup pass could backfill them to explicit `null` on first write, but the runtime treats them identically.
- The Google Sheets sync item the user wants for production notes will hook off this `tabId` field — one Sheets tab per slate tab when that ships. Schema is forward-compatible.

---

## 2026-06-09 — NewTaskModal lazy-fetches preprod columns when opened outside DashboardClient

**Timestamp:** 2026-06-09T18:55:00Z

**User prompt (verbatim):** None — self-reported follow-up to the people-page task-icon commit (`1c32c47`). The inline UpdatesLog → NewTaskModal flow mounts the modal outside `PreprodConfigProvider`, so `usePreprodConfig()` returns the default `{ statuses: [] }` context and the modal incorrectly trips its "no columns yet" guard for prospects even when the Pre-Production board has columns.

**Response summary:** Added a lazy-fetch fallback in `NewTaskModal` — when `taskType === 'preprod'` and the context statuses are empty, the modal calls `GET /api/preprod-board/columns` once and uses the result. The context path (dashboard surface) still short-circuits the fetch when statuses are already populated. No call-site changes needed.

**Files changed:**
- `components/dashboard/NewTaskModal.tsx` — added `lazyPreprodStatuses` state + a one-shot `useEffect` that fetches `/api/preprod-board/columns` when (taskType === 'preprod') && (ctx statuses empty) && (not already fetched). `preprodStatuses` derives from context if available, else lazy-fetched, else `[]` (which keeps the "no columns yet" guard active until the fetch resolves). Added `TaskTypeStatus` to the `task-phase` type import.

**Implementation summary:** Defensive: if the modal is mounted under `PreprodConfigProvider` (the dashboard case), `ctxPreprodStatuses.length > 0` is true and the effect early-returns without hitting the API. Outside the provider (people-page UpdatesLog → task icon), the fetch fires once and caches the result in component state. Submit stays disabled with the existing "no columns yet" copy if the API genuinely returns an empty list.

**Decision rationale:** Considered wrapping a higher-level layout (or even root `layout.tsx`) in `PreprodConfigProvider` instead — declined because that would require fetching the column list on every page navigation, including pages that have nothing to do with tasks. The modal-internal lazy fetch keeps the cost paid exactly when needed.

**Alternatives considered:**
- Wrap `<PersonDetailClient>` in `PreprodConfigProvider` — works but couples two unrelated surfaces; the moment any other surface needs the task icon (project pages, asset pages, etc.) the same wrapper repeats. Modal-side fetch keeps callers free of provider awareness.
- Pass preprod statuses through as a prop from the people page — would mean fetching server-side in `app/people/[personId]/page.tsx` and threading the value through PersonDetailClient → UpdatesLog → NewTaskModal. The lazy fetch is leaner.

**Commands/checks:** None beyond TypeScript-level changes.

**Assumptions / follow-ups:** If we end up needing this fallback in more places, promote `PreprodConfigProvider` to the app shell instead — but only if we hit 3+ surfaces, per "rule of three" refactor.

---

## 2026-06-09 — People-page tweaks: Referred by field, prospect stage badge (7-stage funnel), inline task creation

**Timestamp:** 2026-06-09T18:45:00Z

**User prompt (verbatim — items 1, 2, 8 of a 6-tweak batch):**
> A secondary field that appears underneath the source entry entitled "Referred by" and it allows the user to type in a name
>
> Another status badge on a prospect (not active client). [7 stages listed: Reached Out, Zoom Meeting Set, Post-Zoom Email Sent, Examples Sent, Proposal Sent, Blueprint SOW & Payment Link Sent, Contract Sent]
>
> The ability to create a task from the people page. A simple task icon next to the attachment would suffice, bring up the same modal as the task dashboard right there on the people page entry.

Clarifications recorded earlier: stage badge sits ALONGSIDE the existing status (not replacing it), free-select (not a forced funnel), prospects only. Referred-by is autocompleted from existing People entries (free-text fallback). Task icon auto-defaults to Pre-Production for prospects, no default for active/inactive clients (depends on Pre-Production board built in the prior commit).

**Response summary:** Added `referred_by` + `prospect_stage` columns to the `prospects` table (v22 migration). Rendered referred-by as a free-text input under Source in both `NewPersonModal` and the Account panel on the detail page, with `<datalist>` autocomplete sourced from existing People company names. Added a 7-stage `PROSPECT_STAGES` enum and rendered it as: (a) a clickable pill in the detail-page header next to the "Prospect" status badge (free-select dropdown that PATCHes on change), (b) a compact chip in both card and row layouts on the list, (c) a row in the Account panel for editing the same value. Added a task icon button next to the existing attach button in the `UpdatesLog` compose footer; clicking opens `NewTaskModal` pre-bound to the current person — defaults `taskType='preprod'` for prospects, leaves it null for active/inactive clients (the modal now renders a 3-button internal picker when `taskType` is omitted).

**Files changed:**
- `lib/store/core-db.ts` — v22 migration: `ALTER TABLE prospects ADD COLUMN referred_by TEXT` + `ALTER TABLE prospects ADD COLUMN prospect_stage TEXT`. Both nullable; idempotent via try/catch.
- `lib/models/prospect.ts` — new `PROSPECT_STAGES` const (7 entries, each with `value`/`label`/`color`), `ProspectStage` type, `PROSPECT_STAGE_VALUES` helper. Added `referredBy: string | null` + `prospectStage: string | null` to the `Prospect` interface.
- `lib/store/prospect-store.ts` — added `referred_by` + `prospect_stage` to `ProspectRow`, `rowToProspect`, the `create()` INSERT statement (and its param signature), and the `update()` UPDATE statement. The `update()` patch type uses `Partial<Omit<Prospect, …>>` so the new fields are auto-accepted without an explicit pick.
- `app/api/prospects/route.ts` — POST handler accepts `referredBy` (trimmed) + `prospectStage` (null-coerced if empty string).
- `app/api/prospects/[prospectId]/route.ts` — PATCH handler routes `referredBy` + `prospectStage` through the existing `str()` helper.
- `components/prospects/NewPersonModal.tsx` — added `referredBy` state with a `<datalist>` autocomplete (populated from a new optional `referrerSuggestions` prop), plus a `prospectStage` `<select>` defaulting to "— not set —". Both fields ride along in the POST body.
- `app/people/PeoplePageClient.tsx` — new `StageBadge` component renders a compact funnel chip (color from `PROSPECT_STAGES`) when `person.status === 'prospect' && person.prospectStage`. Wired into both `PersonCard` and `PersonRow` (stacked below the status badge in cards, inline beside it in rows). Now passes `referrerSuggestions` to `NewPersonModal`.
- `app/people/[personId]/PersonDetailClient.tsx` — imported `PROSPECT_STAGES`; new `ProspectStageBadge` component (pill-styled `<select>` matching the active-client status badge UX) rendered in the header next to the "Prospect" badge — PATCHes `prospectStage` on change. Added `referredBy` + `prospectStage` to `AccountPanel`'s edit state, `handleCancel`, and `handleSave` payload. Added a "Referred by" row to both the prospect AND active-client branches of `AccountPanel`, and a "Stage" row to the prospect branch. UpdatesLog invocation now passes `companyName` + `personStatus` for the new task-icon plumbing.
- `components/prospects/UpdatesLog.tsx` — new required props `companyName` + `personStatus`. New task button rendered next to the existing attach paperclip (same compose-footer treatment); clicking sets `showNewTask = true` and mounts a `NewTaskModal` with `clientNames={[companyName]}`, `defaultClientName={companyName}`, `lockedClient`, and `taskType` set to `'preprod'` for prospects or `undefined` for clients (triggers the modal's new internal picker).
- `components/dashboard/NewTaskModal.tsx` — `taskType` prop is now optional. When omitted, internal `taskType` state starts at `null` and the modal renders a 3-button picker (Pre-Production / Editing / Platform) at the top of the form; once clicked, the rest of the form unlocks. Title becomes the plain "New Task" until type is picked. Submit guards on `!taskType`. All existing call sites that pass a `taskType` are unchanged.

**Implementation summary:**
- Pretty straightforward CRUD extension: two new nullable columns + the wiring through the model, store, API, and three UI surfaces.
- `referred_by` is intentionally free-text instead of an FK to `prospects.prospect_id` so an editor can record "Tom Calabrese (LinkedIn DM)" without forcing a People record to exist first. Autocomplete via `<datalist>` gives the snappy reuse path when the referrer IS already in the system.
- `prospect_stage` is a free-string slug into the `PROSPECT_STAGES` enum, with stage validation living at the application layer rather than a CHECK constraint — keeps the door open to renaming/reordering stages without a schema change.
- The stage badge in the detail header is a custom-styled `<select>` (same pattern as the existing active-client status select) so it's clickable and editable inline. On the list, it's a smaller read-only chip — clicking the row navigates to the detail page where the stage can be changed.
- Task icon button uses the same compose-footer button styling as the attach paperclip; sits to its right with a `Create task for {companyName}` tooltip.
- Making `NewTaskModal.taskType` optional was the cleanest way to honor the "auto for prospects, no default for clients" spec — adding a 3-button picker at the top of the modal lets the active-client case open without a pre-selected type. The picker disappears once a type is chosen, so the form layout stays compact for the common case.

**Decision rationale:**
- **Free-text referred_by over a strict person-id FK:** Editors record referrers from outside the existing People list all the time (LinkedIn DMs, podcast guests, etc.). An FK would force every referrer into the system as a stub prospect — annoying friction. Autocomplete via `<datalist>` still gives the dedupe path when the name IS already there.
- **`PROSPECT_STAGES` as a typed enum constant in the model (not a DB lookup table):** The list is small and admin-curated; coupling it to source means PR-reviewable changes and TypeScript-checked usage. A lookup table would have added a second admin surface for a list that changes rarely.
- **Stage badge is a `<select>` styled as a pill, not a button-opens-dropdown:** Native `<select>` is more accessible, free of click-outside complexity, and matches the existing active-client status pattern exactly.
- **Compact chip on the list (not editable from the list):** Inline-editing on the list would mean either (a) a dropdown that stops row-click navigation, or (b) a more complex hover-only affordance. Neither is worth the complexity when the detail page handles editing one click away.
- **Modal-internal picker over caller-side picker for "no default" task type:** Keeps the people-page integration to a single button + no taskType prop, and keeps the modal's own DOM the source of truth for its current state. Cleaner than threading a picker through the people-page tree.

**Alternatives considered:**
- Inline-editable stage chip on each list row — rejected per above; preserves row-click as navigation.
- Adding a separate `referred_by_person_id` column AND keeping the free text as a fallback — overengineering for v1; if the user later wants navigation from referrer chip to the referrer's page we can resolve `referred_by` against `prospects.company` on demand or add the FK then.
- Putting the task icon as a per-row button in the list — the user's "next to the attachment" wording pinned the location to the UpdatesLog compose footer where the paperclip lives; per-row icons would need a different UX justification.
- Forcing a stage on prospect creation — explicitly avoided per the empty-by-default "Stage" picker in `NewPersonModal` ("— not set —"). Many prospects come in mid-funnel from external sources; auto-tagging "Reached Out" would be misleading.

**Commands/checks:**
- No dev server started (per [[feedback_never_start_dev_server]]).
- Grep verified `<UpdatesLog />` is invoked from one place only (`PersonDetailClient.tsx`) — no other surfaces needed the new required props.
- Migration v22 idempotent (try/catch on ADD COLUMN).

**Assumptions / follow-ups:**
- A future iteration could resolve `referred_by` to a clickable link when the value matches an existing prospect — handled later if the user requests it.
- If the stage list grows or wants per-user customization, we can mirror the Pre-Production board's pattern (`task_phase_configs`-style table + access list). v1 keeps it as a static enum.

---

## 2026-06-09 — Pre-Production task board (new /dashboard tab, admin-configurable columns)

**Timestamp:** 2026-06-09T18:00:00Z

**User prompt (verbatim — part of a 6-tweak batch):**
> Another big one - a Pre-Production task dashboard. Status' are unknown - I would want to temporarily allow admin-set users to create and rearrange status' within the dashbaord to allow them to set it up as they see fit.

User clarified: no seed/starter set; empty by default; admin can SELECT which non-admin users are allowed to edit statuses; the tab should come BEFORE Editing in the dashboard tab order; otherwise mirrors the existing Editing board.

**Response summary:** Added a third `task_type` ('preprod') to the existing Editing/Platform board system on `/dashboard`. Columns live in a new `task_phase_configs` table (DB-backed instead of hardcoded), with full CRUD via a column-editor modal reachable from the board toolbar. Permission to edit columns is a new per-user access list (`preprod_board_admins`), mirroring the existing prospect-access / editpanel-access pattern; admins always have it. Empty board renders an empty-state with a CTA (or polite copy for users without permission).

**Files changed:**
- `lib/store/core-db.ts` — v21 migration: `task_phase_configs` (config_id, task_type, slug, label, color, sort_order, timestamps; UNIQUE(task_type,slug)) + `preprod_board_admins` (user_id PK, granted_by, granted_at).
- `lib/store/preprod-board-admin-store.ts` — new. `canEditPreprodColumns`/`getUsersWith…`/`grant…`/`revoke…` — mirror of prospect-access-store.
- `lib/store/task-phase-config-store.ts` — new. CRUD for column configs: `getPhaseConfigsForType`, `getPhaseStatusesForType` (TaskTypeStatus shape for UI), `createPhaseConfig` (auto-slugifies + ensures uniqueness within task_type), `updatePhaseConfig` (label/color only — slug is immutable), `deletePhaseConfig`, `reorderPhaseConfigs` (transactional batch), `countTasksInPhaseSlug` (used by delete-confirm).
- `lib/models/task-phase.ts` — added `'preprod'` to TaskType union as the FIRST entry (drives tab order), with empty placeholder statuses. Added `resolveTaskTypeConfig(taskType, dynamicPreprodStatuses?)` that merges live DB statuses for preprod and falls through to static config for editing/platform. `isTerminalStatus` now safely returns false when terminalStatus is empty (preprod has no auto-terminal in v1).
- `lib/services/api-auth.ts` — added `requirePreprodBoardAdmin(req)` helper.
- `app/api/admin/preprod-board-admins/route.ts` — new. GET/POST/DELETE, admin-only. Mirrors `/api/admin/prospects-access`.
- `app/api/preprod-board/columns/route.ts` — new. GET (any logged-in user, drives UI) + POST (preprod-board-admin only) with label/color validation.
- `app/api/preprod-board/columns/[configId]/route.ts` — new. PATCH (rename / recolor) + DELETE (409 with taskCount if column still has tasks).
- `app/api/preprod-board/columns/reorder/route.ts` — new. POST batch reorder.
- `app/api/tasks/route.ts` — POST validator now accepts `'preprod'` alongside `'editing'`/`'platform'`.
- `app/dashboard/page.tsx` — fetches `getPhaseStatusesForType('preprod')` and `canEditPreprodColumns(...)` server-side, passes them down to DashboardClient.
- `components/dashboard/DashboardClient.tsx` — wraps TaskBoard in a new `PreprodConfigProvider` so the dynamic column list and edit-permission flag are available throughout the dashboard's task surfaces without prop-drilling.
- `components/dashboard/preprod-config-context.tsx` — new. React context with `{ statuses, canEditColumns, refresh }`; column editor calls `refresh()` after every mutation so the kanban stays in sync without a full reload.
- `components/tasks/TaskBoard.tsx` — uses `resolveTaskTypeConfig(activeTaskType, preprodStatuses)` in place of `getTaskTypeConfig` everywhere it determined columns. Accepts `'preprod'` in the localStorage taskType restore. Toolbar "+ New Task" button now hidden for preprod (column-level "+" handles it, matching Editing). New "Manage columns" toolbar button (preprod tab + canEditColumns only). Empty-state branch when `activeTaskType === 'preprod' && statuses.length === 0` with "Set up columns" CTA (or read-only message for non-permitted users). New `PreprodColumnEditorModal` mounted alongside `NewTaskModal`. Drag-validation now uses the resolved (dynamic) config.
- `components/tasks/TaskDetailModal.tsx` — uses `resolveTaskTypeConfig` so the status dropdown shows preprod columns when a preprod task is selected; task-type switcher computes the new default from the resolved config too.
- `components/dashboard/NewTaskModal.tsx` — uses `resolveTaskTypeConfig` for default status; disables submit + shows "no columns yet" hint if preprod tab is opened with an empty column list. Title now reads "New Pre-Production Task" for preprod.
- `components/tasks/PreprodColumnEditorModal.tsx` — new. Add/rename (inline)/recolor (swatch-cycle through a 13-color palette matching the existing Editing/Platform palette)/reorder (up/down arrows)/delete (with confirm step + task-count guard surfaced from the 409 response).
- `components/settings/PreprodBoardAccessPanel.tsx` — new. Mirror of ProspectsAccessPanel — list/grant/revoke the per-user permission.
- `app/settings/page.tsx` — mounted `<PreprodBoardAccessPanel />` next to `<ProspectsAccessPanel />` under the admin-only block.

**Implementation summary:**
- Columns are persisted in a generic `task_phase_configs` schema keyed by `task_type` so configurability can later extend to other task types without another migration — but only `'preprod'` reads from it in v1; `'editing'` and `'platform'` stay on their hardcoded `TASK_TYPE_CONFIGS` entries.
- Slugs are auto-generated from labels on create (`/[^a-z0-9]+/g → '_'`) and uniquified per task_type (`brief_drafted`, `brief_drafted_2`, …). Slugs are immutable; renaming changes the display label only, so the existing `tasks.status` references never go stale.
- A new React context (`PreprodConfigContext`) lets TaskBoard / TaskDetailModal / NewTaskModal all consume the same live statuses + the user's edit permission. The context's `refresh()` re-fetches from `/api/preprod-board/columns` after every editor mutation so the kanban + dropdowns update without a full page reload.
- Delete is guarded by a `countTasksInPhaseSlug` lookup: the API returns 409 with the live count if any tasks still live in the column, and the editor surfaces "Column has N tasks. Move them first." Avoids silent task orphaning.
- Empty-state UX: when preprod has zero columns, the kanban body becomes a centered "No Pre-Production columns yet." card with a "Set up columns" button for permitted users; non-permitted users see "Ask an admin to set up columns for this board." The toolbar "+ New Task" button is suppressed and NewTaskModal disables submit (with the same hint) if someone reaches it via the locked-client flow from elsewhere.
- The Pre-Production tab is the FIRST entry in `TASK_TYPE_CONFIGS`, which drives `task-phase-tabs` ordering in TaskBoard's toolbar. The default `activeTaskType` stays `'editing'` because a fresh preprod board is empty — landing new users on a blank kanban would be a poor first impression. localStorage restore now also accepts `'preprod'`.

**Decision rationale:**
- **Generic `task_phase_configs` table (keyed by task_type) over a preprod-only `preprod_columns` table:** Same schema, leaves the door open to making Editing/Platform configurable later without another migration. Net zero current code complexity.
- **Slug-immutable / label-mutable:** Renaming a column shouldn't migrate every `tasks.status` row — it's purely cosmetic. Slug stays the storage key; this also matches how Editing/Platform statuses work today (their slugs are stable values like `'cutting'`, `'color_polish'`).
- **`requirePreprodBoardAdmin` auth helper, dedicated table for the access list:** Mirrors the existing `prospect_access` / `editpanel_access` convention rather than inventing a new permission model. Real admins always pass.
- **Up/down arrows instead of drag-and-drop reorder in v1:** The editor is occasional-use and an admin-only surface — drag-and-drop would mean pulling `@dnd-kit/sortable` into a new component for marginal UX win. Arrows are trivially accessible too.
- **`isTerminalStatus` becomes "false when terminalStatus is empty":** Avoids accidentally matching status `''` for preprod. Means preprod tasks never auto-set `completedAt` on transition — the user's spec didn't request a terminal/done concept and v1 leaves it out cleanly.
- **Empty board hard-blocks task creation rather than auto-creating a "Backlog" column:** User explicitly said "No seed starter set." A reasonable empty-state with a CTA respects that without forcing them to delete a placeholder column on first use.
- **Tab default stays Editing:** First-render UX. Existing users with stored `lpos:tasks:taskType` land where they were; new users land on Editing (which has content) instead of an empty Pre-Production board.

**Alternatives considered:**
- Inline "+ Add column" pill at the end of the kanban row instead of a "Manage columns" modal — works but exposes the same surface to non-permitted users (worse: would have to invisible-only-for-admins which is brittle). Modal entry behind a permission-gated toolbar button is cleaner.
- Storing column configs in `lpos_settings` (the KV table from v20) as a JSON blob — would have collapsed v21 to zero new tables but lost SQL-level uniqueness/sort_order semantics and made `countTasksInPhaseSlug` impossible without parsing JSON on every delete.
- Adding `is_terminal` flag in v1 so admins can mark a "Done" column that auto-stamps `completedAt` — deferred to a follow-up to keep v1 surface tight. Current behavior: if an admin names a column "Done" (slug `'done'`), `isTerminalStatus` still returns false because the static config's `terminalStatus` for preprod is `''`. That's acceptable until terminal semantics are explicitly requested.

**Commands/checks:**
- No dev server started (per [[feedback_never_start_dev_server]]).
- Grep verified no other call sites consume `getTaskTypeConfig` for preprod statuses (only TaskCard's `isTerminalStatus(task.taskType, task.status)` which safely returns false, and PlatformListView's `getStatusLabel`/`getStatusColor` which only render for `activeTaskType === 'platform'`).
- Migration v21 is idempotent (`CREATE TABLE IF NOT EXISTS` + try/catch).

**Assumptions / follow-ups:**
- No terminal-column flag in v1; if user reports needing auto-`completedAt` on a "Done" column, add `is_terminal INTEGER` to `task_phase_configs` and update `isTerminalStatus` + `TaskStore.update` to consult it.
- The "Manage columns" button is the only entry point — works fine but a per-column kebab menu (rename/delete inline on the kanban) could be a future ergonomic win.
- Tasks #2–#6 in the same batch (Referred by field, prospect stage badge, task icon on people rows, film day tabs, asset move between projects) are queued and will land in subsequent commits.

---

## 2026-06-08 — Delivery uploads heartbeat during multi-GB R2 transfers (no more 3-min false-fail)

**Timestamp:** 2026-06-08T19:25:00Z

**Prompt:** "[upload-queue] auto-failing stale job 83943667-93a7-4ba0-af84-4c519f4fe4a9 (Jacquelyn Full Interviews) — status=uploading limit=3min  Somebody is trying to creare a delivery link"

**Response summary:** Diagnosed the auto-fail as a missing heartbeat during long single-file uploads. The "Jacquelyn Full Interviews" delivery covered 14–20 GB raw interview files (confirmed in `media_files`). The `UploadQueueService` sweep auto-fails any non-`processing` job whose `updatedAt` is older than 3 min — but the Phase A loop in `app/api/projects/[projectId]/delivery/route.ts` only called `setProgress` *between* files, never *during* a single `uploadToR2` call. So multi-GB uploads (which take 5–20+ min apiece) timed out mid-flight while bytes were actively streaming to R2. The pattern existed already (`lib/services/leaderpass-publish.ts:215` heartbeats during the Cloudflare encode wait), the delivery route just didn't use it.

**Files changed:**
- `app/api/projects/[projectId]/delivery/route.ts` — `uploadToR2` now accepts an optional `onProgress(loaded)` callback wired to the AWS SDK `Upload`'s `httpUploadProgress` event; Phase A and Phase C upload calls compute a per-file progress band and emit `setProgress` with real bytes-uploaded text ("Uploading file 1 of 5: foo.mp4 — 2.3 GB / 16.9 GB") on each tick. Phase C wraps `transcodeProxy` in a 60s `setInterval(queue.heartbeat, ...)` since ffmpeg runs for minutes with no JS-side callback. Small `humanBytes` helper inlined.
- `lib/services/upload-queue-service.ts` — `patch()` now early-returns when the job is in a terminal status (`done`/`failed`/`cancelled`), and `fail`/`complete`/`cancel` also early-bail before touching the DB if the job is already terminal. This fixes a secondary state-flap bug where a `setProgress` call from a background IIFE that didn't notice the auto-fail would resurrect the in-memory job back to `uploading` while the persistent record stayed `failed`.

**Implementation summary:** The AWS SDK's `Upload` class from `@aws-sdk/lib-storage` already emits `httpUploadProgress` events on every multipart part upload (verified against `node_modules/@aws-sdk/lib-storage/dist-types/Upload.d.ts:46` and `types.d.ts:3` — `Progress.loaded?: number`). Plumbing that through to `queue.setProgress` gives both heartbeat refresh *and* visible byte-progress for the user with no polling. `setProgress` calls `patch()` which refreshes `updatedAt`, so the 3-min sweep sees regular activity. The terminal-state guard in `patch()` is the right place because all the public mutators (`setProgress`/`setCompressing`/`setProcessing`/`complete`/`fail`/`cancel`) route through it — a single check covers them all. The explicit early-bail in `fail`/`complete`/`cancel` covers the additional DB write that those methods do outside of `patch`, so DB and memory stay in sync.

**Decision rationale:**
- **`httpUploadProgress` over a blind heartbeat interval:** Same wall-clock cost, but the user sees real bytes-uploaded ("2.3 GB / 16.9 GB") instead of staring at "Uploading file 1 of 5…" for 15 min. Mirrors what every other progress UI in the app does.
- **Per-file progress band (1..56 split N ways) instead of a single rolling counter:** Keeps the existing phase percentages (Phase A 1–56, register 58–62, Phase B implicit, Phase C 68–98) intact so the UI's progress bar doesn't go backwards.
- **Heartbeat for ffmpeg, real progress for R2:** Parsing ffmpeg's stderr for time-progress would be 30 lines and brittle; a 60s heartbeat is enough since the sweep only requires <3 min between updates.
- **Patch-level terminal guard:** Centralized in the one private method all mutators route through. Alternative was per-method guards on the six public mutators — more code, easier to miss one.

**Alternatives considered:**
- Bumping `UPLOAD_TIMEOUT_MS` from 3 min to e.g. 30 min — band-aid that masks the real issue (no progress emitted during long ops) and would still falsely fail on slow links. Rejected.
- Only the heartbeat interval (no real byte progress) — works for the sweep but worse UX. Rejected since `httpUploadProgress` is free.
- Disabling the sweep entirely — too aggressive; the sweep does catch genuinely abandoned jobs in other code paths.

**Commands/checks:**
- `npx tsc --noEmit -p tsconfig.json` — clean.
- Verified AWS SDK Progress signature against `node_modules/@aws-sdk/lib-storage/dist-types/{Upload,types}.d.ts`.
- Verified the asset sizes in `lpos-canonical-assets.sqlite` (14–20 GB `*Full_Interview.mp4` files in the affected project).
- Verified the failed jobs in `lpos-ingest-queue.sqlite.upload_job_records` (two attempts at `Jacquelyn Full Interviews`, both auto-failed by sweep).

**Assumptions / follow-ups:**
- R2 multipart upload uses default `@aws-sdk/lib-storage` chunking, which emits `httpUploadProgress` per part — typically every few seconds for multi-GB files. Comfortably under the 3-min threshold.
- Did not modify the in-flight failed jobs in the DB; the user can retry the delivery and it should now succeed.
- The two stuck Jacquelyn jobs (`83943667…` and `17c9880f…`) may still have background IIFEs running and could eventually finish uploading + register the delivery link successfully on the ingest side, even though the queue UI shows `failed`. If a duplicate delivery shows up on retry, the user can delete one. Not worth chasing — the new uploads will report progress correctly.

---

## 2026-06-03 — Comment reply date right-justified (parity with main comments)

**Timestamp:** 2026-06-03T00:55:00Z

**Prompt:** "Jordan JohnsonJun 8, 2:53 PM\n\nThat is how a comment reply is formatted - the date and time need to be right justified like main comments."

**Summary:** Comment replies in the asset sidebar rendered author and date as adjacent inline spans with no gap, gluing them together ("Jordan JohnsonJun 8, 2:53 PM"). Main comments don't have this problem because they wrap their author/date row in a `.mad-comment-header` flex container that combines with the existing `.mad-comment-date { margin-left: auto }` rule to push the date to the right edge. Replies skipped the wrapper and laid the spans out as bare inline siblings. Fix: wrap the reply's author + date in the same `.mad-comment-header` div the main comment uses. Zero new CSS — the existing `margin-left: auto` rule handles right-justify automatically once the parent is a flex container.

**Files changed:**
- `components/media/MediaDetailPanel.tsx` — added `<div className="mad-comment-header">` wrapper around the reply's `.mad-comment-author` + `.mad-comment-date` spans (around line 1037).
- `docs/project history.md`, `docs/changelog.json`.

**Implementation summary:**
- Pre-fix JSX (simplified):
  ```jsx
  <div className="mad-comment-reply">
    <span className="mad-comment-author">{r.authorName}</span>
    <span className="mad-comment-date">{date}</span>
    <p className="mad-comment-text">{r.text}</p>
  </div>
  ```
- Post-fix JSX:
  ```jsx
  <div className="mad-comment-reply">
    <div className="mad-comment-header">
      <span className="mad-comment-author">{r.authorName}</span>
      <span className="mad-comment-date">{date}</span>
    </div>
    <p className="mad-comment-text">{r.text}</p>
  </div>
  ```
- `.mad-comment-header` rule (line 4951 in `app/globals.css`): `display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap`. Combined with `.mad-comment-date { margin-left: auto }` at line 4991, this pushes the date to the right edge inside any header it sits in. Now applies to replies for free.

**Decision rationale:** Reused the existing main-comment header class rather than introducing a new `.mad-comment-reply-header` modifier. Both flows want the same visual: author name on the left, date on the right, single-row flex wrap. If replies later want different chrome (smaller avatar, different padding, etc.) we can add a `.mad-comment-reply .mad-comment-header` descendant selector then; for now nothing diverges.

**Alternatives considered:**
- New CSS rule on `.mad-comment-reply` itself to make it a flex container — rejected: the `<p class="mad-comment-text">` child would then also become a flex child, requiring an additional `flex-basis: 100%` hack to force it onto its own row. Wrapping is cleaner.
- Add a separator (` · `) between author and date — rejected: doesn't match the user's request ("right justified like main comments") and would still leave them on the left edge.
- Inline `style={{ display: 'flex', ... }}` on the reply div — rejected: ad-hoc styling diverges from the CSS-class pattern the rest of the panel uses.

**Commands/tests run:** `npx tsc --noEmit -p tsconfig.json` — clean.

**Assumptions / follow-ups:**
- The `VideoTheaterMode` comment panel renders reply author + text but does NOT render a reply date today (`vt-cp-reply` only has author + text). If we ever add a date there, the same flex-header wrap pattern applies.
- Requires Next.js rebuild for the JSX change to apply.

---

## 2026-06-03 — Version chip → hybrid semver (`major.minor.<auto-patch>`)

**Timestamp:** 2026-06-03T00:50:00Z

**Prompt:** "Should we convert LPOS version convention to something more akin to 1.0.1, 1.1.9, 1.3.5, etc? Rn, it's like v78 and jumps by a ton each time I update and rebuild it." → Confirmed: Option A (Hybrid: 1.0.<auto-patch>).

**Summary:** Converted the top-left version chip from `v.<commit-count> · <short-sha>` (e.g. `v.78 · a1b2c3d`) to a hybrid semver scheme `<major>.<minor>.<patch> · <short-sha>` (e.g. `0.1.77 · a1b2c3d`). `major.minor` come from `package.json.version` and are bumped manually when something user-noticeable ships; `patch` is auto-computed at server start as the number of commits since the last commit that changed the `"version":` line in `package.json`. Bumping minor in `package.json` (and committing it) resets patch to 0 because the bump commit becomes the new anchor. Cannot forget to bump — patch always advances.

**Files changed:**
- `lib/version.ts` — rewrote `readGit()` to read `package.json.version`, parse `major.minor`, and compute `patch` via `git log -1 --format=%H -G '^[ \t]*"version":' -- package.json` followed by `git rev-list --count <anchor>..HEAD`. Added `major`, `minor`, `patch` fields to `AppVersion`. Kept `count` (total commit count) for backwards compatibility / forensics. Display string changed.
- `docs/README.md` — rewrote the "Build / Version Tag" section to describe the new scheme + bumping checklist; updated the dirty-marker example.
- `docs/project history.md`, `docs/changelog.json`.

**Implementation summary:**
- **Anchor lookup uses `git log -G`.** The regex `^[ \t]*"version":` matches only the diff hunks that *changed* the version line of `package.json` (not surrounding context, not deps that happen to mention versions). Unrelated package.json edits (adding deps, changing scripts) don't reset the patch.
- **`git rev-list --count <anchor>..HEAD`** counts commits strictly *after* the anchor. When the anchor IS HEAD (you just bumped + committed), patch = 0. The very next commit lands as patch = 1.
- **Runtime validated** before commit: `node --import tsx --eval "require('./lib/version.ts').getAppVersion()"` returns `0.1.77* · 1a3dd50` against the current repo state (anchor at commit `0c62fea`, 77 commits since, `package.json.version` = `0.1.0`, dirty tree from an untracked Windows-pathed file). After this commit lands the next boot reads `0.1.78`.
- **VersionTag component unchanged.** It consumes only `version.display`, `.sha`, `.branch`, `.date`, `.dirty` — all preserved. No other callers consume `.count` directly.
- **No `v.` prefix on display.** The old format used `v.78`; semver convention is bare-number `0.1.77`. The chip in the UI no longer starts with a `v.`.

**Decision rationale:** Hybrid wins over pure-semver because it preserves the "can't forget to bump" virtue of the old commit-count system while adding semantic prefix for noticeable milestones. Manual semver alone would require a discipline / changelog process LPOS doesn't have today; the auto-patch sidesteps that entirely. Cosmetic-only relabel (Option C) would not have addressed the "jumps by a ton" complaint — auto-patch only jumps if you've been making lots of commits *since the last minor bump*, which is exactly when "lots of work has accumulated" is *accurate* and the displayed number is meaningful.

**Alternatives considered:**
- **Pure semver from `package.json`** (Option B) — rejected: forgettable. After 10 commits with no manual bump, the displayed version is unchanged and stale. The SHA next to it disambiguates, but the version number stops being informative.
- **CalVer (e.g. `2026.06.03`)** — not offered: doesn't convey what changed, only when. The current commit-count scheme has the same problem; switching to CalVer doesn't fix the user's stated concern.
- **Tag-anchored patch (read latest annotated git tag, count from there)** — rejected: requires tagging discipline LPOS doesn't have. The package.json field is already an existing surface; piggy-backing on it costs nothing.
- **Per-file `.version-anchor` companion** — rejected: extra file to keep in sync with `package.json.version`. The `-G` regex against `package.json` itself is simpler and uses no extra storage.

**Commands/tests run:**
- `npx tsc --noEmit -p tsconfig.json` — clean.
- Runtime: `node --import tsx --eval "const v = require('./lib/version.ts').getAppVersion(); console.log(v.display)"` → `0.1.77* · 1a3dd50`. Validated `major/minor/patch` fields all populate correctly.
- Anchor math: `git log -1 --format=%H -G '^[ \t]*"version":' -- package.json` → `0c62fea…`. `git rev-list --count 0c62fea..HEAD` → 77. Matches the displayed patch.

**Assumptions / follow-ups:**
- Requires a Next.js rebuild + server restart for the new display to appear.
- If `package.json` is ever moved/renamed in git history, the anchor lookup may walk past the rename point. Unlikely concern for LPOS; not a problem today.
- If we ever introduce a second top-level `"version":` field in `package.json` (highly unlikely — `npm` enforces uniqueness), the regex would still anchor correctly because both lines living in one file would both match the same diff.
- Editpanel has its own separate version scheme (per `editpanel_build_release.md` memory) — untouched.

---

## 2026-06-03 — Platform list column headers: larger + free-floating

**Timestamp:** 2026-06-03T00:45:00Z

**Prompt:** "Lets also slightly increase the size of the top level category headers (description, client, person, status, and priority) so that they stand out as such and ditch the blue bar behind them. It makes more sense to have them free floating where they are."

**Summary:** Tweaked `.platform-list-cols` (the row of column labels above the platform list): bumped font-size from `0.72rem` to `0.85rem` so they read clearly as column headers, and removed the bar chrome — `background`, `border-bottom`, `position: sticky`, `top: 0`, and `z-index: 2` are all gone. Headers now sit in normal document flow with no surface behind them; uppercase + letter-spacing + 600 weight remain as the typographic cues that they're labels, not data.

**Files changed:**
- `app/globals.css` — only `.platform-list-cols` ruleset.
- `docs/project history.md`, `docs/changelog.json`.

**Implementation summary:**
- Dropped `background: var(--surface, #1a1a1a)` (the "blue bar" the user described — `--surface` resolves to the dark neutral panel color in this theme), `border-bottom: 1px solid var(--line)`, and the sticky positioning (`position: sticky; top: 0; z-index: 2`). Free-floating in flow.
- Font-size 0.72rem → 0.85rem. Modest bump — enough to register as a header without dominating the rows.
- Padding adjusted from `10px 16px` to `12px 16px 8px` so headers sit a touch lower from the page chrome and tighter against the first group below them (no border to separate them anymore).
- Grid template, gap, casing, weight, letter-spacing all unchanged — alignment with the row content stays pixel-identical.

**Decision rationale:** The user's "free floating" cue strongly implied dropping sticky too — keeping it sticky without a background would look ugly on scroll (transparent labels overlapping group headers). The 0.85rem size is a calibrated middle: 0.72 → 0.85 is a noticeable jump (~18%) but still smaller than body text (1rem), preserving the visual hierarchy where category group headers (1rem, 600 weight) remain the dominant tier above the column labels.

**Alternatives considered:**
- Keep sticky, add subtle bottom shadow on scroll instead of a full bar — rejected: still adds chrome, contradicting the "free floating" direction.
- Bump to 0.9rem or larger — rejected: would compete with the category group header for visual dominance.
- Drop uppercase styling to match a more modern aesthetic — rejected: the user only asked to remove the bar and resize, not redesign. The uppercase + letter-spacing combo is exactly what reads as "these are column labels."

**Commands/tests run:** CSS-only change; no typecheck needed.

**Assumptions / follow-ups:**
- Requires Next.js rebuild for the CSS bundle to update.
- If the user later wants the headers to follow the scroll without the bar, we could re-add `position: sticky` with `background: linear-gradient(180deg, var(--surface) 80%, transparent)` for a fade-out — but that's a different design call than what was asked.

---

## 2026-06-03 — Drag handles to reorder platform categories (any user)

**Timestamp:** 2026-06-03T00:40:00Z

**Prompt:** "Can we quickly add a drag/drop handle on the left side of each platform category to allow at-will reordering by any user?"

**Summary:** Added a per-category grip-icon drag handle on the left edge of every live category group in `PlatformListView`. Any signed-in (non-guest) user can grab a handle and drag the category up or down to change the global order; the new order persists immediately via the existing `POST /api/task-categories/reorder` endpoint, whose auth gate was dropped from `admin` to `user`. Tasks-into-categories drag (the existing feature) keeps working unchanged — the two drag flows coexist in the same `DndContext` and are disambiguated in `handleDragEnd` by the `active.id` prefix.

**Files changed:**
- `app/api/task-categories/reorder/route.ts` — `requireRole(req, 'admin')` → `requireRole(req, 'user')`, plus a comment explaining the rationale.
- `components/tasks/PlatformListView.tsx` — main edit:
  - State shape changed from `categories: string[]` to `categories: CategoryEntry[]` (keeps `categoryId` alongside the label).
  - New `hasRealIds` flag tracks whether the live API populated the state (the starter fallback has no real IDs, so reorder is disabled in that state).
  - `DroppableCategoryGroup` replaced by `SortableCategoryGroup`, which uses `useSortable` from `@dnd-kit/sortable` (single ID = both draggable item AND droppable target on the same DOM node).
  - `SortableContext` wraps the live (non-orphan) categories; orphans + "Uncategorized" render after the context, pinned in place — they remain droppable for task drops but aren't reorderable themselves.
  - `handleDragEnd` now dispatches by `active.id` prefix: `CAT_DROP_PREFIX::Label` → category reorder (arrayMove + optimistic state + POST); raw UUID → existing task→category drop.
  - On reorder POST failure, the local state rolls back to the server's authoritative `GET /api/task-categories` response; a transient inline error message renders above the list.
  - New `DragOverlay` variant `.platform-list-drag-overlay--category` shows a ghost of the category label being dragged.
- `app/globals.css` — new rules: `.platform-list-group-header-wrap` (flex row for handle + header), `.platform-list-group-drag-handle` (left-side grip, opacity-on-hover mirroring the task-row handle), `.platform-list-group--reordering` (dim while being dragged), `.platform-list-drag-overlay--category` (bolder ghost with the category color stripe), `.platform-list-reorder-error` (subtle inline error surface).

**Implementation summary:**
- **ID disambiguation:** the same `CAT_DROP_PREFIX` (`cat::`) is now used for both the existing task-drop target and the new category-sortable item. `useSortable` internally combines `useDraggable` + `useDroppable` under one ID, which is what we want — a single category group is both "things land here" (for task drops) and "this can be moved" (for category reorder). The shared `handleDragEnd` figures out which one just happened from `active.id`'s shape.
- **Sortable scope:** only the live (non-orphan, real-categoryId) categories are inside the `SortableContext`. Orphans and the synthetic "Uncategorized" bucket render after the context and are deliberately not reorderable — there's no `categoryId` to send to the reorder endpoint, and pinning them at the end matches their semantic role (these are leftover labels, not first-class categories).
- **Handle-only activation:** `attributes` + `listeners` from `useSortable` are spread on the small grip `div` only — not the whole header or the group. Clicking the header still toggles collapse; only grabbing the grip starts a category drag. `onClick={e => e.stopPropagation()}` on the handle prevents the click from bubbling into the header's collapse toggle.
- **Auth gate:** `requireRole(req, 'user')` matches the spirit of the request ("any user"). Guests stay blocked (they have a tightly-restricted allow-list anyway). Create/rename/delete on the sibling routes are still `admin`-only — reordering is cosmetic, the destructive operations stay gated.
- **Optimistic update + rollback:** local state is reordered immediately via `arrayMove(categories, oldIdx, newIdx)`; the POST happens in the background; on failure, the component fetches `GET /api/task-categories` to restore the authoritative state and surfaces a small inline error.
- **Fallback safety:** when the API hasn't responded yet, the component still renders with `STARTER_PLATFORM_CATEGORIES`. In that state `hasRealIds` is false → drag handles are hidden → no reorder attempt is made.

**Decision rationale:** Reused the in-tree `@dnd-kit/sortable` (already a dep, already used elsewhere) rather than adding a new dnd library. Reused the existing reorder endpoint rather than building a per-user view-order store; the user asked for "at-will reordering" without qualifying "per user", so global reorder is the simplest interpretation that matches the wording. Per-user view order can be layered on later if users start fighting over the global order — would land as a per-user JSON store keyed by user id, hydrated client-side after the global fetch.

**Alternatives considered:**
- Per-user view order via localStorage / per-user DB column — rejected as scope creep for the "quickly add" framing. Easy to add later if shared-order proves contentious.
- Up/Down arrow buttons on each group instead of a drag handle — rejected: the user asked for drag/drop specifically, and the @dnd-kit infrastructure is already wired for task drag in the same view.
- Make orphan groups also reorderable — rejected: they have no real `categoryId` to send to the reorder endpoint. Pinning them at the end matches their leftover/legacy status.
- Keep the gate as admin and add a separate "anyone can reorder" endpoint — rejected: the existing endpoint already does exactly the right thing; the gate change is a one-line, low-blast-radius edit.

**Commands/tests run:** `npx tsc --noEmit -p tsconfig.json` — clean.

**Assumptions / follow-ups:**
- Requires a Next.js rebuild + server restart for the route change + the bundled component change to take effect.
- If the user later wants per-user category order (so one user's drag doesn't reorder it for the rest of the team), the path is: add a `user_category_order` table or per-user JSON store; client hydrates from it post-API-fetch; reorder POST writes the per-user store rather than the shared one. The current shared-order implementation can coexist as a default starting point.
- The drag handle is hidden until the group is hovered (`opacity: 0` → `0.5` on `:hover`) to keep the header chrome clean. If users miss the affordance, we can pin it visible.

---

## 2026-06-03 — Transcript selection batch bar streams a zip (the actual one users use)

**Timestamp:** 2026-06-03T00:30:00Z

**Prompt:** "Transcript bulk downloads arren't zipping I don't think?" → after probing the route, user clarified: "I selected 3 transcripts from the transcript tab and downloaded from the batch bar. Got 3 single trancsripts".

**Summary:** The earlier "transcripts download-all" fix (`fcbb3c4`) only addressed one of two batch-download paths. The path the user actually uses — the in-list selection batch bar in `components/projects/ProjectDetail.tsx` (`Download TXT` / `Download Timecoded` buttons that appear when transcripts are selected via the checkbox column) — was untouched and still triggered N individual `<a>.click()` events with a 300ms gap between each. Symptom: select 3, get 3 separate save prompts and 3 separate files. Fixed by adding a new `POST /api/projects/[projectId]/transcripts/download-zip` endpoint (selection-driven, accepts `{jobIds, type}`) and rewriting `batchDownload` to POST + save the response blob.

**Verification of the earlier fix:** the `download-all` route was confirmed correct via direct curl against the running server with the `LPOS_LP_TOKEN` machine token — returned `Content-Type: application/zip` and a valid 200KB zip containing 95 files for a transcript-heavy project. Build mtime (13:28:53) preceded the running server's start time (13:29:07) by 14 seconds, confirming the route was live. Audit eliminated server-side defect.

**Files changed:**
- `app/api/projects/[projectId]/transcripts/download-zip/route.ts` *(new)* — POST endpoint for selection-driven bulk zip. Same archiver+PassThrough+`Readable.toWeb` pattern as `download-all`. Single-file fast path preserves "no zip when only one" rule. Supports `type: 'txt' | 'timecoded-txt'`. Reuses `readTranscriptDownload` and `resolveTranscriptDisplayName` from `lib/transcripts/store.ts`.
- `components/projects/ProjectDetail.tsx` (`batchDownload`) — rewritten. ≤1 eligible → keep existing direct-link single-file download (no fetch round-trip). ≥2 eligible → `fetch(POST)` to the new zip endpoint, save the response blob via `URL.createObjectURL`, parse `Content-Disposition` for the server-provided filename.
- `docs/project history.md`, `docs/changelog.json`.

**Implementation summary:**
- **Naming convention** matches the existing single-file route: `<displayName>.txt` for `txt`, `<displayName>-timecoded.txt` for `timecoded-txt`. Same `sanitizeForFilename` regex `[^a-zA-Z0-9 _\-().]`. Collision-safe via the same `uniqueName(used, name)` helper as the `download-all` and `photos/download-zip` routes.
- **Skip-missing semantics**: if `readTranscriptDownload` returns `null` for a jobId (e.g. `timecoded-txt` requested on a transcript with no JSON source), that entry is silently dropped from the zip — mirrors the single-file GET route's `null → 404` skip pattern at the per-jobId level. If everything is filtered out → 404 with `{error: 'No matching transcripts found'}`.
- **Zip outer filename**: `transcripts-<projectName><-timecoded?>.zip`, sanitized. The `-timecoded` suffix distinguishes a TXT bundle from a timecoded bundle when both are requested for the same project.
- **Client-side**: `fetch(POST).then(res.blob()).then(URL.createObjectURL).then(<a>.click)` — standard pattern. Parses the server's `Content-Disposition` header for the filename so the saved zip is named consistently with the server's choice (the browser falls back to `a.download` otherwise).

**Decision rationale:** Split this out as a new route rather than overloading `download-all` because the two flows have different request shapes (GET-all vs POST-selection) and different naming preferences (timecoded vs all). The 90% shared archiver code is small enough to duplicate; refactoring into a `streamTranscriptsZip` helper can wait until a third caller appears. Single-file fast path on the server preserves the "no zip when only one" rule even if a future caller hits the endpoint with a single jobId.

**Alternatives considered:**
- Overload `download-all` with a `?jobIds=…` query param — rejected: GET URL-length limits cap real-world selections, and bulk selections fit better in a POST body.
- Keep the client loop but build the zip in the browser via `JSZip` — rejected: requires a new client dependency, doesn't stream, and re-creates server-side zip code on the client.
- Server-side helper extraction `streamTranscriptsZip()` shared with `download-all` — deferred per the YAGNI principle until a third zip endpoint shows up.

**Commands/tests run:**
- Earlier `download-all` route verified via `curl -sI -H "Authorization: Bearer $LPOS_LP_TOKEN" http://localhost:3000/api/projects/<id>/transcripts/download-all` → 200, `application/zip`. Downloaded body confirmed valid zip via `file` + `unzip -l` (95 entries, 205KB).
- `npx tsc --noEmit -p tsconfig.json` — clean.

**Assumptions / follow-ups:**
- The fix requires a Next.js rebuild + server restart to pick up the new route (`app/api/.../download-zip/route.ts`) and the client change in `ProjectDetail.tsx`. User runs prod from this tree and manages the server lifecycle.
- The right-click context menu in `TranscriptOutputList.tsx` still only exposes single-file downloads (intentional — context menu is a per-row action). No batch path from the right-click menu today.

---

## 2026-06-03 — Decision: defer comment-recency cache; plan full Frame.io-comment decoupling

**Timestamp:** 2026-06-03T00:20:00Z

**Prompt:** "The actual issue is that it seems latest comments only sorts alphabetically. If possible, we shouldn't rely on frame at all for this - just reference whether or not LPOS has any stored comments and when they were made. This might hint towards a much larger, future change - removing the dependancy on frame for comments in videos."

**Summary:** Confirmed the root cause of the sort defect: `activity_events` in production has **zero `frameio.comment.*` rows** (`sqlite3 data/lpos-activity.sqlite "SELECT COUNT(DISTINCT asset_id) FROM activity_events WHERE event_type IN ('frameio.comment.created','frameio.comment.reply.created');"` → 0). Frame.io webhooks aren't producing local data, so the MediaTab "Latest comments" sort falls through to its alphabetical name tiebreak for every pair — observably "alphabetical only" as the user reported. A small recency-cache fix was proposed (new `asset_comment_recency` table + three writers + reader rewrite, no UI changes, ~80 LOC, lazy backfill). **User chose to defer the small fix and queue the larger refactor** — full Frame.io-comment decoupling. Sort stays broken until that ships. No files changed in this entry.

**Files changed:** `docs/project history.md`, `docs/changelog.json` — planning/decision record only.

**Decision rationale:** User reasoning — they want LPOS unreliant on Frame.io for comments soon, so building a stopgap recency cache that the refactor would obsolete in weeks isn't worth the round-trip. Accepting a few weeks of alphabetical fall-through on the sort is fine. Backfill strategy chosen for when the refactor lands: **lazy only** — no eager admin backfill, no boot-time backfill — recency rebuilds as users browse.

**Planned refactor (for future implementation, not now):**

1. **Local `comments` table** in `lpos-core.sqlite` (or a new `lpos-comments.sqlite`):
   ```sql
   CREATE TABLE comments (
     id              TEXT PRIMARY KEY,    -- LPOS-generated UUID; not Frame.io's ID
     project_id      TEXT NOT NULL,
     asset_id        TEXT NOT NULL,
     parent_id       TEXT,                -- thread reply
     author_user_id  TEXT,                -- LPOS user; NULL for external Frame.io reviewers
     author_name     TEXT NOT NULL,       -- denormalised for external authors
     body            TEXT NOT NULL,
     video_ts_seconds REAL,
     completed_at    TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL,
     deleted_at      TEXT,
     external_frameio_id TEXT,            -- Frame.io comment ID, NULL while standalone
     external_sync_state TEXT              -- 'pending' | 'pushed' | 'failed' | 'external_only'
   );
   ```
   Index on `(project_id, asset_id, created_at DESC)` to serve the sort directly via `MAX(created_at)` per asset.

2. **Bidirectional Frame.io sync engine** (transition-period only):
   - LPOS → Frame.io: outbox queue. New/edited/completed/deleted LPOS comments are pushed to Frame.io best-effort with retry. `external_frameio_id` is filled in on first successful push.
   - Frame.io → LPOS: webhook (`/api/webhooks/frameio`, existing endpoint) writes incoming external comments into the local table with `external_sync_state = 'external_only'`. Periodic reconciliation poll catches dropped webhooks (per-project, e.g. every 5min while a project has an active deliverable).
   - Conflict policy: `author_user_id IS NOT NULL` → LPOS wins (we authored it). `author_user_id IS NULL` → Frame.io wins (external reviewer).

3. **UI rewrite — `GET /api/projects/:p/media/:a/frameio/comments`**:
   - Reads from local `comments` table.
   - The route name `/frameio/comments` is misleading post-refactor; consider renaming to `/comments` and leaving a thin redirect.

4. **Sort fix lands "for free":** the new reader for `getLatestCommentByAssetForProject` queries the local `comments` table directly. No separate recency cache needed; the timestamp column already exists per row.

5. **Decommission path:** once stable for one project lifecycle (~ a few weeks), Frame.io webhooks become optional. Continue posting to Frame.io for external-reviewer visibility, but LPOS is the source of truth. Eventually deprecate `comment-authors.json` + `comment-replies-store` per-project JSON files — both are subsumed by the new table.

**Alternatives considered:**
- Small recency cache as a stopgap (the rejected option) — would have shipped the sort fix today but is throwaway work once the refactor lands.
- Land the sort fix AND start the refactor in parallel — rejected: the recency cache file/table would become a stale alt-truth competing with the new comments table during the transition; cleaner to do one move.

**Commands/tests run:** SQL probe of `lpos-activity.sqlite` confirming the empty result; read-through of `comment-authors-store.ts`, `comment-replies-store.ts`, `frameio.ts`, the comments POST route, and the webhook handler.

**Assumptions / follow-ups:**
- Sort fall-through to alphabetical is accepted as a known issue until the refactor ships. Worth a small UI hint? E.g. greying out the "Latest comments" sort option, or showing a tooltip "(no comment data yet — feature in development)". Open question for the user.
- Memory `project_local_comments_refactor.md` records this plan for future sessions.

---

## 2026-06-03 — Breadcrumb/home occlusion guard

**Timestamp:** 2026-06-03T00:15:00Z

**Prompt:** "Ensure we never accidentally make the top left home button/breadcrumb inaccessible on a user's dashboard. This would be a UI problem."

**Summary:** Forward-looking guard so the top-left home/back breadcrumb in `AppShell` cannot be hidden by a future modal or overlay. Three changes: (1) bumped `.breadcrumb-bar` z-index from 40 to 10500, above the highest currently-used overlay layer (10000); (2) added a translucent dark backdrop + `backdrop-filter: blur(6px)` so the icons stay legible when the bar floats over a modal backdrop; (3) added a documented `.breadcrumb-bar--locked` opt-out modifier (dim + non-interactive) for the rare case where a flow legitimately needs to prevent navigation. Recorded the invariant + an "adding a new overlay" checklist in `docs/README.md`.

**Files changed:**
- `app/globals.css` — `.breadcrumb-bar` z-index + backdrop, new `.breadcrumb-bar--locked` modifier.
- `docs/README.md` — new "Navigation Invariants" section before "Build / Version Tag".
- `docs/project history.md`, `docs/changelog.json`.

**Implementation summary:**
- Audit found four current 9999 overlays (`.restart-banner`, `.mad-confirm-overlay`, `.cam-panel--overlay-fs`, `.vt-backdrop`) and one 10000 overlay (`.restart-dialog-overlay`). None of them are flows where "trap the user" is intentional — they all have their own close affordances. Raising the breadcrumb above them gives the user a guaranteed escape hatch without changing those flows' close behavior.
- z-index headroom: 10500 leaves 500 between the breadcrumb and the highest current overlay, large enough to accommodate future high-stacking elements without immediately needing another bump.
- Backdrop: `rgba(18, 16, 14, 0.42)` matches the app's dark neutral base; `backdrop-filter: blur(6px)` (+ `-webkit-` prefix) softens whatever's behind it so the home + back icons keep contrast.
- `.breadcrumb-bar--locked`: drop-in modifier, no consumers today — added so future "blocking" flows have a documented opt-out rather than reaching for a higher z-index modal.

**Decision rationale:** Picked the forward-looking guard (z-index + backdrop + documented invariant) over a targeted fix because the user explicitly chose "no known reproducer" and asked for the general defense. Could not justify a Playwright test for the invariant — no automation harness installed in this repo today — so the invariant is recorded in `docs/README.md` with an "adding a new overlay" checklist for code review.

**Alternatives considered:**
- **Per-modal escape audit only** (leave breadcrumb at 40, add Esc/X to each overlay) — rejected: requires diligence on every future PR; the z-index bump is structurally enforced.
- **Add a Playwright/RTL invariant test** — deferred: no test harness for this kind of layout assertion exists in the repo today; introducing one solely for this change is outsized.
- **Skip the backdrop blur and let the breadcrumb sit visually flush over modal backdrops** — rejected: the icons would wash out against a dark backdrop, which is exactly the failure mode the user described.

**Commands/tests run:** `grep`-based audit of all `z-index: 9999/10000/10500` selectors in `globals.css`. `npx tsc --noEmit -p tsconfig.json` — clean (CSS-only + docs changes).

**Assumptions / follow-ups:**
- No `.breadcrumb-bar--locked` consumers today. If a future upload/payment flow needs it, the modifier is ready to use.
- The bump from z-index 40 → 10500 is a large jump that should be invisible in the normal (no-overlay) case: the breadcrumb already sits in dead space at top-left and the new backdrop is subtle. Worth a visual smoke test post-deploy.

---

## 2026-06-03 — Audit: "Sort by latest comment" in project media

**Timestamp:** 2026-06-03T00:10:00Z

**Prompt:** "Can we check to ensure the sort by latest comment method in project media is working correctly?"

**Summary:** Read-through of the four paths that make this sort work: (a) the DB query, (b) the API serialization, (c) the webhook ingest that produces the underlying events, and (d) the UI comparator. The core mechanism is correct: indexes are right, asset_id is always set on the events, Map→Record serialization doesn't drop entries, and the comparator's nulls-last + stable-name-tiebreak is intentional design (per the code comment). **Three behavioral issues were found that can make the sort lag or under-report — none are addressed in this entry; they're reported back to the user for a fix decision.**

**Files changed:**
- `docs/project history.md`, `docs/changelog.json` — audit-only entry; **no code changes**.

**Findings:**

1. **LPOS-authored comments don't update sort until Frame.io webhook echoes them back.** `POST /api/projects/:p/media/:a/frameio/comments` posts to Frame.io and patches local `commentCount` but does NOT write to `activity_events`. The event only appears when the webhook arrives. Effect: sort lags by webhook round-trip time, and is permanently wrong if a webhook is dropped. Fix: insert the activity_event server-side in the POST handler with the same `dedupe_key` the webhook would use, so the eventual webhook delivery dedupes via the unique index. ~15-line change.

2. **Comment edits/completions/deletions don't bump recency.** Webhook handler drops everything except `comment.created` at `webhooks/frameio/route.ts:153`. SQL only includes `frameio.comment.created` and `frameio.comment.reply.created`. This is correct if "latest comment" means "latest comment **created**"; wrong if it means "latest **activity** on a comment thread". Design call — flagged for user decision, not a code bug.

3. **Webhook drops events when `frameio.assetId` no longer matches.** `findAssetByFrameioFileId` walks every project and matches by `asset.frameio.assetId`. If that ID was cleared (e.g. during reset/republish), the webhook logs a warning and drops the event. Edge case, rare in practice, but it's the failure mode where the sort would be silently wrong.

**Decision rationale:** Per the original plan, item 2 was scoped as "audit, pause, report — don't fix anything beyond an obvious defect." None of the three findings is an obvious defect with a single right answer (#1 has a clean fix but should be confirmed; #2 is a design call; #3 is a separate webhook-resilience concern). Reporting back rather than landing speculative fixes.

**Alternatives considered:** Land the issue-1 fix inline as part of the audit — rejected to honor the "pause and ask" plan and let the user weigh issue-2 alongside it.

**Commands/tests run:** Read-only inspection of:
- `app/api/projects/[projectId]/media/route.ts`
- `components/projects/MediaTab.tsx`
- `lib/store/activity-db.ts`
- `app/api/webhooks/frameio/route.ts`
- `app/api/projects/[projectId]/media/[assetId]/frameio/comments/route.ts`

**Assumptions / follow-ups:** Awaiting user decision on which of the three findings to fix and how. Likely outcome is at least #1 (instant local activity_events).

---

## 2026-06-03 — Bulk transcript download streams a zip

**Timestamp:** 2026-06-03T00:05:00Z

**Prompt:** "We need to batch transcript downloads into a single zip file, no matter the browser or OS. This would be true unless the user is only downloading a single transcript."

**Summary:** Rewrote `/api/projects/[projectId]/transcripts/download-all` from a concatenated plaintext blob (one big `transcripts-<projectId>.txt` with `===` separators) to a streamed `.zip`, one `.txt` per transcript, named after each transcript's display filename. Preserves the user's stated edge case: when exactly one transcript exists, the route falls back to streaming the single `.txt` directly — no zip wrapper. Cross-browser/OS safe via standard `Content-Type: application/zip` and `Content-Disposition: attachment` headers.

**Files changed:**
- `app/api/projects/[projectId]/transcripts/download-all/route.ts`
- `docs/project history.md`, `docs/changelog.json`

**Implementation summary:**
- Same streaming pattern as the existing `photos/download-zip` route: `archiver('zip', { zlib: { level: 6 } })` piped into a `PassThrough`, returned as a web `ReadableStream` via `Readable.toWeb`.
- Per-entry name: `<sanitized display filename>.txt`, with a `uniqueName(used, name)` helper for collision-safe dedup (mirrors `(1)`, `(2)` suffixes from the photos route).
- Outer zip filename: `transcripts-<project.name>.zip` (sanitized), with fallback to `projectId` if the name is missing.
- Single-transcript fast path: streams plaintext directly with `Content-Type: text/plain; charset=utf-8`, filename `<displayName>.txt`.
- Empty-content guard: if `readTranscriptText` returns empty, the entry's body is `(no content)` (matches prior behavior).

**Decision rationale:** Mirrored the existing photos zip route to avoid introducing a second pattern for the same primitive. Used `archive.append(text, { name })` rather than writing temp files because the transcript content is already in memory and small; this avoids touching the disk and the project transcripts directory layout. The single-transcript fast path preserves direct-download for the common case while making bulk downloads zip-shaped per the user's spec.

**Alternatives considered:**
- Include all variants per transcript (txt + srt + vtt + json) under a per-transcript subfolder — rejected as scope creep. Today's `download-all` only emitted `.txt`; matching that surface keeps the change minimal. Easy to extend later via a `?include=srt,vtt` query param.
- Always emit a zip (no single-file fast path) — rejected per the user's explicit "unless only downloading a single transcript" requirement.
- Keep the concatenated `.txt` as a `?format=txt` option — deferred; no one's asking for it and the zip is strictly more useful.

**Commands/tests run:** `npx tsc --noEmit -p tsconfig.json` — clean.

**Assumptions / follow-ups:**
- `archiver` was already a dependency (used by `photos/download-zip`), no install needed.
- The `TranscriptPageActions` button uses a plain `<a download href=…>`, which keeps working unchanged: the browser respects the `Content-Disposition` filename from the response, so the link no longer "lies" about producing a `.txt` when the server now answers with a `.zip`.

---

## 2026-06-03 — Copy-link button shows checkmark + "Link copied"

**Timestamp:** 2026-06-03T00:00:00Z

**Prompt:** "We need to show visually that the user has copied a direct asset link from the sidebar. Right now, they click the link button and nothing happens. All it would take is making that icon a little check mark with potentially a 'link copied' text"

**Summary:** Added in-button visual feedback to the "Copy link to this asset" button in `MediaDetailPanel`'s header. On a successful clipboard write, the chain icon swaps to a checkmark, a green-tinted "Link copied" label appears next to it, and the button's `aria-label`/`title` switch to "Link copied" for assistive tech. State resets after 1.8s. The toast is kept as a redundant signal; the in-button affordance is now the primary cue.

**Files changed:**
- `components/media/MediaDetailPanel.tsx`
- `app/globals.css`
- `docs/project history.md`, `docs/changelog.json`

**Implementation summary:**
- New local state `assetLinkCopied: boolean` next to the existing `cfEmbedCopied` pattern (line 311).
- On successful `navigator.clipboard.writeText`, set `assetLinkCopied=true` and `setTimeout(..., 1800)` to reset, mirroring the `copiedShareId` flow used by the per-review-link rows.
- Button JSX: ternary renders either the new checkmark SVG + `<span class="mad-copy-link-label">Link copied</span>` or the original chain SVG. `aria-label`/`title` track the state.
- New CSS rules `.mad-copy-link-btn`, `.mad-copy-link-btn--copied`, `.mad-copy-link-label`: padding/gap for the inline label, success-green color/tint while copied, transition for smooth swap. Uses `var(--success, #4ade80)` so the fallback works if the CSS var isn't defined.

**Decision rationale:** Matches an existing, working pattern in the same file (per-review-link copy buttons at lines 749-761) rather than introducing a new mechanism. Toast was kept as belt-and-suspenders — the user's report ("nothing happens") suggests the toast isn't registering for them, but removing it would silently regress for anyone who does rely on it. Failure path (clipboard write rejected) still shows only the error toast and no checkmark, which is correct.

**Alternatives considered:**
- Pure-toast (status quo) — rejected per the user's request; toast clearly isn't sufficient feedback.
- Drop the toast entirely — deferred; can remove later if confirmed redundant.
- Animate the button (pulse) — unnecessary complexity given the checkmark + label is unambiguous.

**Commands/tests run:** `npx tsc --noEmit -p tsconfig.json` — clean (no MediaDetailPanel-related errors).

**Assumptions / follow-ups:**
- The 1.8s reset window is matched to the existing `cfEmbedCopied` timing (2s) and `copiedShareId` (2s); slightly faster to feel snappier with the always-visible "Link copied" label.

---

## 2026-05-29 — Decouple attachment serving from Prospects access

**Timestamp:** 2026-05-29T14:36:23Z

**Prompt:** "Hey is the task attachment logic being served through the prospects system? Users without access to prospects are not able to see attachments in tasks, even if the task has nothing to do with prospects." → after diagnosis, user chose to keep one shared attachment system and make its authorization context-aware ("Ok let's do option a").

**Summary:** Confirmed the bug and fixed it. The shared attachment download endpoint (`/api/attachment`) serves both task-comment and prospect-update attachments but unconditionally required Prospects access, so users without Prospects access got a 403 when opening attachments on ordinary tasks. Changed the endpoint to authorize by the attachment's key prefix: task attachments now require only a valid session (matching task-comment uploads), while prospect attachments still require Prospects access.

**Files changed:**
- `app/api/attachment/route.ts`
- `docs/README.md` (new Attachments section)
- `docs/project history.md`, `docs/changelog.json`

**Implementation summary:**
- Moved key validation ahead of the auth check, then branched: `key.startsWith('attachments/tasks/')` → `getSession` (401 if no session); otherwise → `requireProspectsAccess` (unchanged behaviour for prospect attachments).
- Keys are minted server-side on upload (`attachments/tasks/<taskId>/…` vs `attachments/<prospectId>/…`), so the prefix is a trusted discriminator. The existing `attachments/` prefix + `..` validation is retained.
- No changes to the R2 service (`lib/services/r2-attachments.ts`), the upload routes, the data model, or the frontend — they were already domain-correct.

**Decision rationale:** Chose Option A (single shared attachment system, context-aware auth) over duplicating the attachment system per domain. The storage layer (`r2-attachments.ts`) and the serve endpoint were already shared and prospects-agnostic except for one hardcoded auth call; the only defect was applying the prospects gate to all downloads. Prefix-based dispatch is an ~8-line change in one file, keeps a single endpoint, and avoids a second copy of the serve logic. Duplication would have added route surface and a second place to fix future attachment bugs while still sharing the R2 client anyway.

**Alternatives considered:**
- Duplicate the attachment system per domain — rejected: more surface, divergent code paths, still shares the R2 client.
- Resource-nested download routes (`/api/tasks/[taskId]/…/attachment`, `/api/prospects/[prospectId]/…/attachment`) to enable per-resource ACLs — deferred: the app has no per-resource membership checks anywhere yet; noted as the upgrade path in `docs/README.md`.

**Commands/tests run:** Code review only; no automated suite run.

**Assumptions / follow-ups:**
- Downloads still have no per-resource ACL: any authenticated user can fetch any task-attachment key, and any Prospects-enabled user can fetch any prospect-attachment key. This matches how uploads currently authorize. Tightening would require the resource-nested routes noted above.
- Repo had unrelated in-flight changes (`lib/services/drive-watcher-service.ts`, `lib/services/drive-sync/`, an assets route) at the time; these were left untouched and excluded from the commit via targeted `git add`.

---

## 2026-05-29 — Notify original commenter when their comment gets a reply

**Timestamp:** 2026-05-29T00:00:00Z

**Prompt:** (continuation of) "…notify the user who made the comment that is being replied to." Follow-up answers: surface = persistent **bell notification**; external Frame.io reviewers = **skip (LPOS authors only)**.

**Summary:** Built a new persistent notification category — "comment" reply notifications — mirroring the existing Prospect notification vertical slice. When a reply is posted to a comment that was authored from within LPOS, the original commenter gets a bell notification (live via Socket.io + web-push) that deep-links to the asset.

**Files changed:**
- `lib/models/comment-notification.ts` *(new)* — `CommentNotification` model, type `'reply'`.
- `lib/store/core-db.ts` — added `comment_notifications` table + `idx_comment_notifs_user_read` index (idempotent `CREATE … IF NOT EXISTS`, created on next boot).
- `lib/store/comment-notification-store.ts` *(new)* — CRUD store (getForUser / getUnreadCount / create / markRead / markAllRead).
- `lib/services/container.ts` — import, global decl, module singleton, `getCommentNotificationStore()`.
- `lib/services/comment-notification-service.ts` *(new)* — `notifyCommentReply(...)`: persist → emit `comment:notification` to `user:{userId}` → best-effort web-push.
- `app/api/notifications/comments/route.ts` *(new)* — GET list + unread; PATCH `markAllRead`.
- `app/api/notifications/comments/[notifId]/route.ts` *(new)* — PATCH mark single read.
- `hooks/useCommentNotifications.ts` *(new)* — fetch + Socket.io subscription + markAllRead.
- `components/shell/NotifBell.tsx` — new **Comments** tab (item component, tab order/label, hook wiring, totals, mark-read, deep-link to `/projects/{id}?assetId={asset}`).
- `app/api/projects/[projectId]/media/[assetId]/frameio/comments/route.ts` — reply branch now calls `notifyCommentReply` for the parent's LPOS author.
- `app/globals.css` — `.notif-panel` widened to `min(380px, calc(100vw - 24px))` to fit a 5th tab without clipping on desktop or overflowing phones; `.notif-tab` gets `min-width: 0` + tighter padding.

**Implementation summary:** There was no media-comment notification channel — the persistent, user-targeted system is the Task/Prospect/Delivery trio (core-db table + store + service emitting a Socket.io event + per-user GET/mark-read routes + NotifBell tab + hook), while the "Pipeline" bell tab is client-only/ephemeral (wrong tool). So this adds a parallel "comment" category in the exact Prospect shape. The recipient is resolved from `comment-authors-store` (`getCommentAuthor(projectId, parentId)` → `{ name, userId }`), which only has a `userId` when the parent was posted inside LPOS; the call is guarded on `parentAuthor?.userId && parentAuthor.userId !== session?.userId` so external-reviewer parents and self-replies notify no one. The notify call is fire-and-forget (`void …catch(() => {})`) so it never blocks or fails the reply POST. Deep-link reuses the established `?assetId=` param that `ProjectDetail.tsx` already consumes to open the media detail panel.

**Decision rationale:** Mirroring the Prospect slice keeps the new category consistent with the three existing ones (same socket-room convention, same read-state model, same bell UX) and minimises surprise. A new category (vs. shoehorning into Task notifications) avoids a bogus `taskId`/`/dashboard?task=` deep-link and keeps the Comments feed cleanly separable. Widening the panel + `min-width:0` was required because the tab bar was sized for exactly 4 equal flex tabs in a 320px `overflow:hidden` panel — a 5th would have clipped.

**Alternatives considered:**
- **Reuse Task notifications** — rejected; type/fields and deep-link are task-shaped.
- **Toast-only / Pipeline tab** — rejected per user choice (needs to persist + survive reload + be cross-device).
- **Notify project team/admins for external-reviewer comments** — rejected per user choice (LPOS authors only).

**Commands/tests run:** `npx tsc --noEmit -p tsconfig.json` → exit 0, 0 errors. (`next lint` not run — repo has no flat ESLint config and the wrapper drops into interactive setup; new files mirror the existing prospect-notification files verbatim in structure.)

**Assumptions / follow-ups:**
- `comment_notifications` is created on the **next server boot** via the idempotent schema exec; until the server restarts, the GET route would error on the missing table (caught client-side as empty). Restart picks it up.
- Notifications fire for **replies only**, not new top-level comments left in LPOS. Could extend later (e.g. notify a project's team on any new comment).
- A reply posted with no session (if that path is ever hit) still notifies the LPOS parent author, which is the desired behaviour.

---

## 2026-05-28 — Right-align comment "Reply" button + reply-mechanism recap

**Timestamp:** 2026-05-28T21:00:00Z

**Prompt:** While you're in there, remind me how replies are set up to work? We had to tweak those. Also - we need to right align the "reply" button and notify the user who made the comment that is being replied to.

**Summary:** Right-aligned the per-comment "Reply" trigger in both the media detail panel and theater mode. Recapped (analysis, no code) how the reply workaround functions. The "notify the original commenter" request was NOT implemented in this entry — it requires a new persistent notification category and a product decision, so it was deferred pending user input (see follow-ups).

**Files changed:**
- `app/globals.css` — `.mad-reply-btn` and `.vt-cp-reply-btn`: added `display: block; width: fit-content; margin-left: auto;` to right-align the trigger under each comment.

**Implementation summary:** Both comment containers (`.mad-comment`, `.vt-cp-comment`) are block-level, so the inline reply trigger sat bottom-left. `margin-left: auto` on a `fit-content` block pushes it to the right edge without touching the container layout. The in-compose "Reply"/"Cancel" action rows were already right-aligned via `justify-content: flex-end`, so only the collapsed trigger needed changing.

**Reply mechanism recap (no code change):** Frame.io V4 has no reply-creation endpoint. `postReply` (`lib/services/frameio.ts`) posts a top-level comment prefixed `"Reply to above: "` so Frame.io reviewers see context, then the route layer records `replyId → parentId` in `data/projects/{projectId}/comment-replies.json` (`comment-replies-store.ts`). On GET, the comments route filters out comments whose IDs are in that map, strips the prefix, and injects them into their parent's `replies[]` array to rebuild the thread. Author display names are stored separately in `comment-authors-store.ts` (`commentId → { name, userId }`) since the Frame.io account author is the LPOS service account, not the human.

**Decision rationale:** `margin-left: auto` on a fit-content block is the minimal, layout-safe way to right-align a single child in a block container — no flex conversion of the parent, no risk to the surrounding comment chrome.

**Commands/tests run:** CSS-only; no compile. Visual reasoning from existing fixed/flow selectors.

**Assumptions / follow-ups:**
- **Notify-on-reply deferred:** the persistent, user-targeted notification system (task/prospect/delivery) has no media-comment category, and the "pipeline" notif tab is client-only/ephemeral. Adding reply notifications means a new notification category (model + core-db table + service + socket event + GET/mark-read routes + NotifBell section + hook). It can only target the parent commenter when that comment was authored from within LPOS (an LPOS `userId` exists in `comment-authors-store`); replies to external Frame.io reviewers have no in-app recipient. Awaiting user decision on scope/surface before building.

---

## 2026-05-28 — Fix: checked-off Frame.io comment resets moments later

**Timestamp:** 2026-05-28T20:53:13Z

**Prompt:** Hey random but when I "check off" a comment in lpos it resets moments later

**Summary:** Fixed a race where marking a Frame.io comment complete (the checkbox in the media detail panel / theater mode) would optimistically check, then visibly un-check itself a beat later. Made the optimistic toggle "sticky until confirmed" and extended the guard to theater-mode toggles.

**Files changed:**
- `components/media/MediaDetailPanel.tsx`

**Implementation summary:** Frame.io comments have no local DB copy — the `completed` flag lives only in Frame.io. The toggle flow was: optimistic UI flip + record a guard in `pendingTogglesRef` + `PATCH`; on PATCH resolve, the `finally` block deleted the guard immediately. But the PATCH is exactly what makes Frame.io fire its `comment.completed` webhook, which the server relays as a `frameio:comments:refresh` Socket.io push, triggering `fetchComments()` a beat *later*. Frame.io's read API briefly lags its own webhook (read-after-write), so that refetch returns the pre-toggle `completed: false` — and by then the guard was already gone, so it clobbered the optimistic value. Theater-mode toggles never populated the guard at all, so they were fully exposed.
  - `fetchComments` now keeps masking with the optimistic value and only drops the guard once a fetched comment's `completed` matches the pending value (i.e. Frame.io has propagated the write).
  - `handleToggleComplete` no longer clears the guard on success (only on failure, alongside the revert) — confirmation is delegated to `fetchComments`.
  - The theater-mode `onCommentCompleted` callback now records the guard too, so toggles made in theater mode get the same protection.

**Decision rationale:** "Sticky until a refetch confirms Frame.io agrees" is robust to arbitrary read-after-write lag without an arbitrary timeout, and self-clears so genuine external changes still flow through once Frame.io is consistent. A fixed grace-period timer was rejected because it breaks if Frame.io is slower than the timeout.

**Alternatives considered:**
- **Fixed N-second grace period before clearing the guard** — fragile; still resets if Frame.io lag exceeds N.
- **Persisting `completed` in a local SQLite mirror** — larger change and introduces a second source of truth to reconcile; unnecessary for a display race.
- **`cache: 'no-store'` on the comments GET** — not the cause; Next 15.2 doesn't cache `fetch` by default, so the data cache was already out of the picture.

**Commands/tests run:** `npx tsc --noEmit -p tsconfig.json` → exit 0, 0 errors.

**Assumptions / follow-ups:**
- Assumes a Frame.io PATCH returning 200 means the write persisted; the guard stays sticky until a refetch confirms, so a comment deleted while a toggle is pending leaves a harmless orphaned entry in the in-memory guard map (bounded by comment count, cleared on panel close).
- Pre-existing uncommitted change to `components/tasks/TaskBoard.tsx` was left untouched and out of this commit.

---

## 2026-05-27 — Move version chip from top-right to top-left

**Timestamp:** 2026-05-27T12:54:33Z

**Prompt:** Ok wait sorry, I don't want to compete with the notif bell or user menu. is top left clean?

**Summary:** Relocated the build version chip from the top-right corner to the top-left to avoid visually competing with the notif-bell / user-menu / storage-gear stack on the right.

**Files changed:**
- `app/globals.css` — `.version-tag` rule: `right: 8px` → `left: 8px`; comment updated.
- `docs/README.md` — Build / Version Tag section: "top-right" → "top-left".

**Implementation summary:** Single-property CSS swap. Top-left at `top: 4px` sits above the breadcrumb bar (which starts at `top: 20px left: 32px`) with comfortable clearance. The navbar pill is centered and only visible on hover, so it doesn't intrude on the corner. The component, server helper, and prop wiring from the previous entry are unchanged.

**Decision rationale:** Top-left is the only "clean" corner — the right side has the bell/menu/gear stack at `top: 20px`, the breadcrumb at `top: 20px left: 32px` leaves the `top: 4px` row free, and the navbar pill is centered. Mobile breakpoint shifts breadcrumb to `left: 16px` but still doesn't reach `top: 4px`.

**Alternatives considered:**
- **Status-bar style band along the top edge** — much heavier visual change; rejected to keep the chip unobtrusive.
- **Bottom-corner placement** — would clash with the storage-gear and tray-group, which are bottom-corner fixed.

**Commands/tests run:** Visual reasoning from existing fixed-position selectors in `globals.css`; no compile needed (CSS-only).

**Assumptions / follow-ups:**
- The chip is still rendered for guests. If the top-left feels too prominent for the guest experience specifically, hide via `.app-home[data-guest] .version-tag, .app-inner[data-guest] .version-tag { display: none; }`.

---

## 2026-05-27 — Auto-advancing build version chip in top-right corner

**Timestamp:** 2026-05-27T12:49:45Z

**Prompt:** We desperatley need to implement some sort of auto-advancing version number system for each git push. I'l like it displayed very small in the top right corner of lpos. This should also help if we ever need to locate lost code like we recently had to do.

**Summary:** Added a small fixed-position build chip to the LPOS shell that reads the current git HEAD at server start and renders `v.<commit-count> · <short-sha>`. The commit count is monotonic (advances every commit, hence every push), and the chip is click-to-copy so the full SHA can be checked out to recover an exact past state.

**Files changed:**
- `lib/version.ts` (new)
- `components/shell/VersionTag.tsx` (new)
- `components/shell/AppShell.tsx`
- `app/layout.tsx`
- `app/globals.css`
- `docs/README.md`

**Implementation summary:**

`lib/version.ts` exports `getAppVersion()` which runs four `execSync` calls — `git rev-list --count HEAD`, `git rev-parse HEAD`, `git rev-parse --abbrev-ref HEAD`, `git log -1 --format=%cI`, plus a porcelain status check for a dirty flag — and caches the result in a module-level variable. stderr is piped to `'ignore'` so failures (no `.git`, shipped build) don't spam logs; on any error we return a safe `v.dev` shape. The repo root is resolved from `__dirname` so production cwd quirks don't matter.

`app/layout.tsx` (a server component) calls `getAppVersion()` once per render and passes the result to `AppShell` as a `version` prop. `AppShell.tsx` accepts the prop and mounts `<VersionTag version={version} />` in both the home and inner layout branches.

`VersionTag.tsx` is a tiny client component that renders the `display` string, a tooltip with the full SHA + branch + commit date, and a click handler that copies the full SHA via `navigator.clipboard`. On copy it briefly swaps the text to "copied".

Styling lives in `app/globals.css` as `.version-tag`: `position: fixed; top: 4px; right: 8px; font-size: 10px; color: rgba(255,255,255,0.34)` — sits above the existing top-right row (notif-bell, user-menu, storage-gear at `top: 20px`) without overlap, almost invisible until hover.

**Decision rationale:**
- **Commit count + SHA over semver** — commit count gives a human-readable monotonic progression with zero maintenance (no version-bump step to forget); the SHA is what actually lets us `git checkout` to recover code. Together they answer "is this newer than what I had?" and "where exactly did this come from?" without any extra tooling.
- **Read git at server start, cache** — chosen over per-request reads to avoid spawning child processes on every page render. The user manages the server lifecycle manually, so a restart-driven refresh matches the existing workflow. Also chosen over a generated `version.json` checked into the repo: no commit-the-version-bump dance, no merge conflicts on the version file, no possibility of forgetting to regenerate.
- **Server prop over `/api/version` fetch** — the version is constant for the life of a page render; passing it as a prop from the server layout avoids an extra round-trip on first paint and keeps the chip visible immediately.
- **Click-to-copy** — surfaces the full SHA (the part you actually paste into `git checkout`) without making the UI noisy.
- **Dirty flag (`*` suffix)** — instantly tells us when the running build doesn't match a tagged commit, which would otherwise silently make a SHA misleading.

**Alternatives considered:**
- **Pre-push hook bumping a version file** — fragile (hooks aren't installed by default for new clones), and creates commit churn for the version bump itself. Rejected.
- **Build-time injection via `next.config.mjs` env vars** — works, but requires a rebuild for every visible version update; the current restart-only flow is lighter.
- **Per-request git lookup** — most accurate but adds a child-process spawn to every render. Rejected; the user opted for restart-on-refresh in the planning question.

**Commands/tests run:**
- `npx tsc --noEmit -p .` — clean.
- Ad-hoc execution of `getAppVersion()` via tsx: returned `{ count: 28, shaShort: '7755ccb', branch: 'main', dirty: true, display: 'v.28* · 7755ccb' }` — dirty flag expected because tree had in-flight edits at test time.

**Assumptions / follow-ups:**
- The `dirty` asterisk will disappear automatically once these changes are committed.
- The version refreshes on server restart, not on commit. If the user wants a "redeploy" indicator that doesn't require a restart, that's a follow-up (e.g. invalidate the cache when a sentinel file changes).
- The chip is unconditionally rendered; if guest users should not see it, the `data-guest` selector on `.app-home` / `.app-inner` can hide it via CSS later.

---

## 2026-05-20 — Mobile layout audit and responsive fixes

**User prompt:** "Can you look over how each page is displayed on mobile devices and see if there's anything we can do to keep all elements on screen? Right now, the home page tabs are cut off on small screens, navigating through projects is a bit of a mess, etc."

**Summary:** Audited the dashboard across page groups for elements overflowing or being cut off on phone-width screens, then applied a single consolidated, mobile-only CSS fix block appended to `app/globals.css`. Fixes the two flagged problems (home tiles clipping off-screen; project workflow nav collapsing to 7 oversized stacked buttons) plus the most impactful additional breakages found in the audit. All changes are CSS-only and gated behind `max-width` media queries, so the desktop experience is unchanged.

**Files changed:** `app/globals.css`

**Implementation summary:** Appended a clearly-marked "Mobile layout fixes" block at the end of `globals.css` (last in source order so it overrides earlier equal-specificity rules without editing them). At ≤768px: `.home-tiles` now wraps instead of overflowing; `.workflow-nav` converts from a button-tile grid into a horizontal-scroll pill strip (compact `.workflow-link` pills) so all 7 stages stay reachable without filling the screen; `.proj-client-grid` drops from 4 columns to 2; slide-in side panels `.sh-panel` and `.sep` are lifted with `bottom: calc(56px + env(safe-area-inset-bottom))` so their footers/close buttons clear the bottom tab bar; `.proj-scripts-toolbar-right` and `.proj-transcript-filter-input` stop forcing horizontal overflow. At ≤480px: home tiles shrink to 132px (2-up), `.proj-client-grid` becomes single-column, `.ma-row` drops its metadata/badge columns (keeping name + actions), `.proj-bulk-bar` wraps, and `.task-col` min-width reduces to 150px. Verified the file's brace balance (3116/3116) after the edit.

**Decision rationale:** Chose CSS-only media-query additions appended at the end of the file because they are low-risk on a live production tree — they cannot affect the desktop layout existing users see, only improve small screens, and they avoid mutating the many existing scattered media-query blocks. The workflow nav was made a horizontal-scroll pill strip (standard mobile pattern) rather than a 2-col grid or dropdown, as it keeps every stage one tap away with no extra interaction while reclaiming vertical space. Reused the existing breakpoints already in the file (768px, 480px) for consistency.

**Alternatives considered:**
- Workflow nav as a compact 2-column grid or a dropdown selector — rejected the dropdown (adds a tap) and the grid (still consumes vertical space); the scroll strip was the best balance. (Posed these options to the user; the clarifying question was dismissed, so proceeded with the recommended scroll-strip.)
- Editing the existing in-place media-query blocks rather than appending — avoided to minimise risk of regressions in the large shared CSS file.
- Forcing side panels to full `100vw` on mobile — skipped; their existing `max-width` already prevents horizontal overflow, so only the bottom-tab-bar overlap needed fixing.

**Commands/tests run:** Static review of JSX class usage and matching CSS rules (two parallel exploration passes); brace-balance check on `globals.css`. No dev server started or restarted (server lifecycle is user-managed); changes require a rebuild/restart to appear in the running production process.

**Assumptions / follow-ups:**
- Changes were not visually verified in a live browser (production server is auth-gated and no browser-automation tooling is installed); fixes are based on source/CSS analysis. Recommend a quick on-device check after the next restart.
- Lower-priority items left as-is for now: platform page inline `60vh` spacing and `.activity-strip-item` max-width — these don't cut content off, just leave extra whitespace.

---

## 2026-05-20 — Add "All" scope tab to task board

**User prompt:** "Can we add an 'all' option on the platform task page along with mine and others? Users are getting confused having to go between the two tabs creating new tasks"

**Summary:** Added a third "All" scope tab to the Mine / Others toggle in TaskBoard. Shows every task of the active type regardless of assignment. No API or filter changes needed — the existing filter already falls through to `return true` for any scope that isn't `'mine'` or `'others'`.

**Files changed:** `components/tasks/TaskBoard.tsx`

**Implementation summary:** Updated `viewScope` state type to include `'all'`, added an "All" button to the scope toggle with matching active styling.

**Decision rationale:** Minimal change — the filter logic already supported a passthrough case; only the type union and UI button were missing.

---

## 2026-05-19 — HLS playback via hls.js

**User prompt:** "Ok let's do it. So hls will improve playback speeds for everyone. Will it affect theater mode/comments/scrubbing/etc?"

**Summary:** Implemented HLS-based video playback across all LPOS video players. Installed hls.js, created a `useHlsPlayer` hook, updated the `frameio-stream` route to serve `highQualityUrl` (H.264 HLS transcode) instead of `originalUrl` (raw file), and wired the hook into `InlineVideoPlayer`, `VideoTheaterMode`, and `MediaDetailPanel`. Fixes `.mov` playback on Chrome/Firefox/Edge and improves scrubbing/seeking speed for all users due to adaptive bitrate HLS vs. raw file download.

**Files changed:**
- `package.json`, `package-lock.json` — added hls.js@1.6.16
- `hooks/useHlsPlayer.ts` — new hook; detects Safari (native HLS) vs. other browsers (hls.js); falls back to direct src for non-HLS URLs
- `app/api/projects/[projectId]/media/[assetId]/frameio-stream/route.ts` — switched from `originalUrl` to `highQualityUrl ?? originalUrl`
- `components/media/InlineVideoPlayer.tsx` — added `useHlsPlayer`, removed `src` from `<video>`
- `components/media/VideoTheaterMode.tsx` — added `useHlsPlayer`, removed `src` from `<video>`
- `components/media/MediaDetailPanel.tsx` — added `useHlsPlayer` at component level; derived `sidebarVideoSrc`; removed `src` from both raw `<video>` elements

**Implementation rationale:** Frame.io's `highQualityUrl` is an H.264 HLS manifest (pre-signed CloudFront URL) that plays in all browsers but requires hls.js on non-Safari. Safari handles HLS natively. The hook detects the browser capability via `video.canPlayType('application/vnd.apple.mpegurl')` and loads hls.js dynamically (code-split) only when needed. All existing scrub/seek/comment logic operates on `videoRef.current.currentTime` and is unaffected — hls.js attaches to the same `<video>` element without changing its API.

**Fallback:** If `highQualityUrl` is null (transcode not ready), the route falls back to `originalUrl`. If hls.js isn't supported, the hook falls back to setting `src` directly.

**Commands run:** `npm install hls.js`, `npx tsc --noEmit` (no new errors)

---

## 2026-04-29 — Git push to remote

**User prompt:** "Can you push the current version of this project to git? Or, lpos-dashboard specifically"

**Summary:** Staged and pushed 111 changed/new files from lpos-dashboard to the remote repository at github.com/lp-jordan/lpos (main branch). Excluded `.DS_Store` files and `runtime/atem-bridge.zip` (binary). Committed as `4-29-26` following the project's date-based commit style.

**Files changed:** 111 files (10,153 insertions, 1,273 deletions) — see git commit `6584493`.

**Implementation summary:** Ran `git add -A` then reset DS_Store and zip files before committing and pushing to origin/main.

**Decision rationale:** Used date-based commit message to match existing project convention. Excluded `.DS_Store` and the binary zip as they are not source files.

**Commands run:** `git add -A`, `git reset HEAD .DS_Store runtime/.DS_Store runtime/atem-bridge.zip`, `git commit`, `git push origin main`

---

## 2026-04-23 — Sardius filename collision handling

**User prompt:** "Yeah, I'd rather confirm overwrite or append a (1) to it, sardius can be weird with matching filenames and overwrites."

**Summary:** Added filename collision detection to the Sardius push flow. Before starting an FTP upload, the API now calls `checkSardiusFileExists` to check if the filename already exists in the target folder. If a conflict is found and the caller hasn't acknowledged it, the API returns a 409 with `{ conflict: true, suggestedName: 'filename(1).mp4' }`. The modal handles this response by pausing the upload loop and presenting two inline buttons: "Overwrite" (re-sends with `overwrite: true`) and "Rename to X(1).mp4" (re-sends with `filenameOverride`). Batch uploads pause on each conflicted asset in sequence and resume after the user resolves each one.

**Files changed:**
- `app/api/projects/[projectId]/media/[assetId]/sardius/route.ts` — added `buildSuggestedName`, collision check before queue creation, `overwrite`/`filenameOverride` body fields, `filename` derived from override or base
- `components/media/SardiusPushModal.tsx` — added `conflict` state, `pushAssets` helper loop (handles 409 conflict mid-batch), `handleResolveConflict`, conflict banner UI, updated `canPush` to block while conflict is pending
- `app/globals.css` — added `.sardius-conflict-banner`, `.sardius-conflict-msg`, `.sardius-conflict-actions`, `.mad-action-btn--danger` classes

**Implementation rationale:** The FTP STOR command silently overwrites existing files; Sardius can behave unexpectedly with duplicate filenames. Checking before upload and surfacing an explicit choice is safer than silent overwrites. The `(1)` suffix mirrors the convention most users expect from OS file dialogs. For batch uploads, the conflict is resolved per-asset without cancelling the rest of the queue.

**Alternatives considered:** Checking all conflicts upfront before starting any uploads — rejected because it requires an extra FTP list call per asset before the loop, adding latency. Per-asset resolution during the loop is already natural given the fire-and-forget pattern.

**Commands/tests:** None run.

---

## 2026-04-23 — Sardius FTP push feature

**User prompt:** "Per-media asset, have an option in the 'more info' sidebar area to push to Sardius. This would open a modal that would read the existing folder structure in the Akamai server Sardius uses and then upload that asset (using the source file) into Sardius along with whatever metadata we tag it with. … Also, this would be a relatively temporary feature because we're moving away from Cyberduck to Cloudflare… Also, I'd want the share URL info BACK from Sardius and available to copy in LPOS."

**Summary:** Added a complete Sardius FTP push workflow. A "Push to Sardius" button appears in the More Info sidebar for any asset that has a local file. Clicking it opens a modal that browses the Akamai FTP watch-folder tree, lets the user select or type a destination path, fill in speakers/categories/publish-profile metadata, preview the JSON sidecar, and trigger an upload. The FTP upload runs in the background; the asset's status cycles none → uploading → queued. Once Sardius has processed the file, the user pastes the assigned URL back into a sidebar field, which stores it as status=ready with a one-click copy button.

**Files changed:**
- `lib/models/media-asset.ts` — added `SardiusInfo`, `SardiusStatus`, `SARDIUS_STATUS_LABEL`, `defaultSardius()`, and `sardius` field on `MediaAsset`
- `lib/models/canonical-asset.ts` — added `'sardius'` to `CanonicalDistributionProvider`
- `lib/store/canonical-asset-store.ts` — wired Sardius into `bundleToProjection`, `CanonicalAssetPatch`, and `patchCanonicalMediaAsset`
- `lib/store/media-registry.ts` — added `sardius` to `AssetPatch`
- `lib/services/sardius-ftp.ts` — new; FTP client using `basic-ftp` with `listSardiusFolders()` and `uploadToSardius()`
- `lib/services/runtime-dependencies.ts` — added Sardius FTP config entry
- `app/api/sardius/folders/route.ts` — new; GET returns Akamai FTP directory tree
- `app/api/projects/[projectId]/media/[assetId]/sardius/route.ts` — new; GET status, POST push, PATCH save URL, DELETE reset
- `components/media/SardiusPushModal.tsx` — new; modal with folder browser, metadata form, JSON preview
- `components/media/MediaDetailPanel.tsx` — added Sardius section, polling, modal trigger, URL paste/copy UI
- `.env.local` — created with `SARDIUS_FTP_HOST`, `SARDIUS_FTP_USER`, `SARDIUS_FTP_PASS`, `SARDIUS_ACCOUNT_ID`
- `package.json` / `package-lock.json` — added `basic-ftp` dependency

**Implementation rationale:** Sardius has no public REST API for uploads — they use an Akamai FTP watch-folder with per-asset JSON sidecars. The upload runs fire-and-forget in the background (matching the existing LeaderPass/Cloudflare pattern) to avoid holding an HTTP connection open during large file transfers. Because Sardius assigns the asset ID internally after watch-folder processing, the share URL cannot be auto-retrieved; the feature stores a "queued" state and provides a paste field for the user to record the URL once Sardius has processed the file. The implementation is intentionally minimal (no new DB tables — uses the existing `distribution_records` table with `provider='sardius'`) to reflect the temporary nature of this feature while a full Cloudflare migration is planned.

**Alternatives considered:** Polling a Sardius API for the asset ID was considered but ruled out because no documented endpoint exists for asset lookup by filename. Auto-constructing the URL was ruled out because the Sardius asset ID is an opaque hash assigned internally, not derivable from the filename.

**Commands/tests run:** `npx tsc --noEmit` — passed with no errors.

**Assumptions / follow-ups:**
- Sardius processes FTP watch-folder uploads every 15 minutes at :00, :15, :30, :45.
- Files must be valid MP4/MOV/MP3/MXF; Sardius retains watch-folder files for 7 days before deleting.
- The `.env.local` contains real FTP credentials and must not be committed to version control. Ensure `.env.local` is in `.gitignore`.
- When ready to fully migrate to Cloudflare, the Sardius section in `MediaDetailPanel` and all associated files can be removed with minimal impact on the rest of the system.

---

## 2026-04-16 — Capture whisper stderr for better transcription failure diagnostics

**Prompt:** Whisper has never worked on this mac since we migrated lpos over from windows — add stderr capture so the actual crash reason surfaces.

**Summary:** `runWhisper` in `MediaProcessor` was spawning whisper with no `stdio` config, so crash output was lost and jobs only reported `whisper killed by signal SIGABRT`. Added stderr capture so the actual whisper error message is appended to the job failure reason.

**Files changed:** `lib/services/media-processor.ts`

**Implementation:** Added `stdio: ['ignore', 'pipe', 'pipe']` to the whisper `spawn` call, buffered stderr, and appended it to the rejection message when whisper exits non-zero or is signalled.

**Rationale:** Whisper has never worked on this Mac since migration from Windows. SIGABRT is most likely a binary/platform issue (e.g. wrong architecture, Metal backend crash, model mismatch) — need the actual stderr to diagnose. Memory pressure was ruled out as the cause given the hardware.

**Alternatives considered:** Logging stderr separately — rejected in favour of surfacing it directly in the job error where it's immediately visible.

**Commands/tests:** None run.

---

## 2026-04-16 — Fix FOREIGN KEY crash in purgeOldJobs on server start

**Prompt:** `[lpos] failed to start: Error: FOREIGN KEY constraint failed at IngestQueueService.purgeOldJobs` — what's this

**Summary:** Server failed to start because `purgeOldJobs` deleted rows from `ingest_jobs` while child rows in `upload_sessions` still referenced them via a FK. Fixed by deleting the matching `upload_sessions` rows first in the same method.

**Files changed:** `lib/services/ingest-queue-service.ts`

**Implementation:** Added a `DELETE FROM upload_sessions WHERE job_id IN (SELECT job_id FROM ingest_jobs WHERE ...)` step immediately before the existing `DELETE FROM ingest_jobs` delete, using the same cutoff timestamp.

**Rationale:** SQLite enforces FK constraints (`PRAGMA foreign_keys = ON` is set in `initSchema`). The `upload_sessions` table declares `FOREIGN KEY (job_id) REFERENCES ingest_jobs(job_id)` with no `ON DELETE CASCADE`, so parent rows can't be deleted while child rows exist. Deleting children first is the minimal, safe fix — no schema migration needed.

**Alternatives considered:** Adding `ON DELETE CASCADE` to the FK — would require recreating the table in SQLite (no `ALTER TABLE ... ADD CONSTRAINT`), more invasive than needed.

**Commands/tests:** None run.

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

---

## 2026-05-30 — Frame.io upload fix: use server-determined media_type from create response as PUT Content-Type

**Timestamp:** 2026-05-30T17:24:33Z

**User prompt (verbatim):** Pasted the new diagnostic output from the failing upload, including `SignedHeaders=[content-type;host;x-amz-acl]` and S3's full `<CanonicalRequest>` block showing `content-type:video/mp4` as the value sent. Full multi-line log with parts 1–4/35 failing identically, each with `SignatureDoesNotMatch`, ending in `[frameio] upload failed: S3 PUT part 2/35 failed: 403 [SignatureDoesNotMatch] ...`.

**Response summary:** The diagnostic (commit 9c72abd) pinpointed it: Frame.io signs each presigned upload_url with `SignedHeaders=content-type;host;x-amz-acl`, meaning the `Content-Type` value sent on the PUT must EXACTLY equal what Frame.io signed for — not just any plausible MIME for the file. The caller (`frameio-upload.ts`) was passing `asset.mimeType ?? 'video/mp4'`, which is a hint that can diverge from what Frame.io actually chose: Frame.io derives the file's media type (likely from the `name` extension passed in the create call), the asset's stored mimeType can be wrong or stale, and the fallback `'video/mp4'` is wrong outright for any non-mp4 file. Either way we ship a Content-Type ≠ what Frame.io signed → 403 on every part. **Fix**: read the `media_type` field from the `local_upload` create response (it's a *required* field on `FileWithUploadUrls` per the V4 OpenAPI spec — Frame.io always returns the server-chosen media type) and use that exact value as the PUT's Content-Type. This guarantees equality by construction regardless of how Frame.io derives it; we don't need to mirror their algorithm. Caller's `mimeType` argument is retained as a fallback in case `media_type` is somehow missing. Added a one-line log when the two differ, so future investigations can see at a glance which file types tend to diverge.

**Files changed:**
- `lpos-dashboard/lib/services/frameio.ts` — (1) added `media_type?: string` to the `createBody.data` type; (2) after extracting `fileId`/`uploadUrls`, extract `signedContentType = fileRecord.media_type || mimeType` and log if they differ; (3) PUT now sends `Content-Type: signedContentType` instead of `Content-Type: mimeType`.
- `docs/project history.md` + `docs/changelog.json` — this log.

**Decision rationale:** Use Frame.io's authoritative value rather than try to predict it. The alternative (derive Content-Type locally from the file extension via a mime-lookup) duplicates Frame.io's logic and would silently drift the moment they change their mapping or add a new extension. Reading the value from the response is one line, has zero failure modes (the field is required per spec), and is self-correcting forever. The `|| mimeType` fallback keeps the old behaviour on the impossible edge case of a server response missing `media_type`. Kept the diagnostic logging from 9c72abd in place — if anything still goes wrong, the next failure will name it precisely.

**Alternatives considered:** (a) Derive Content-Type from `uploadName`'s extension via a mime-types lookup — rejected for the duplication-of-logic reason above. (b) Hardcode `Content-Type: application/octet-stream` — would only work if Frame.io defaults to that, which the spec doesn't promise; brittle. (c) Skip `Content-Type` entirely (Frame.io's spec only mandates `x-amz-acl: private` on the PUT) — rejected; `SignedHeaders` includes `content-type`, so the header must be present and must match. (d) Add a retry that flips Content-Type on mismatch — needless given the deterministic fix is available.

**Commands run:** `npx tsc --noEmit` → exit 0 (no type errors). No build/test run (server lifecycle is user-managed).

**Assumptions / follow-ups:** Assumes `media_type` is always present in the create response (V4 OpenAPI says `required`). Restart LPOS and retry the upload; the `[frameio-v4] signed Content-Type = "<X>" (caller passed "<Y>")` log will be useful if there's still any mismatch (very unlikely). If parts continue to 403 with `SignatureDoesNotMatch`, the next thing to investigate is whether undici fetch is silently adding a `Transfer-Encoding: chunked` header that isn't in `SignedHeaders`. lpos-dashboard committed (not pushed).

---

## 2026-06-16 — Rename "Domain Restrictions" to "Security" and add signed URL toggle

**User prompt:** Can we do a quick test? Can we change "Domain Restrictions" to "Security" and expose both the domain restrictions stuff and a signed URL toggle for assets in the media tab of LPOS? That way I can quickly test to see if LP platform already handles videos with signed URLs.

**Summary:** Renamed the "Domain Restrictions" button on the media detail panel to "Security" and expanded the modal to include a "Require signed URLs" checkbox at the top (above the existing domain restrictions list). Wired the toggle through the API layer so it reads and writes `requireSignedURLs` on the Cloudflare Stream video.

**Files changed:**
- `lib/services/cloudflare-stream.ts`
- `app/api/projects/[projectId]/media/[assetId]/cloudflare/route.ts`
- `components/media/DomainRestrictionsModal.tsx`
- `components/media/MediaDetailPanel.tsx`

**Implementation summary:**
- Added `requireSignedURLs?: boolean` to the `VideoSettings` interface in `cloudflare-stream.ts` and passed it through to the Cloudflare `POST` body in `applyVideoSettings`.
- Extended `getVideoDetails` return type to include `requireSignedURLs: boolean`, extracted from the CF GET response.
- Route (`cloudflare/route.ts`) now accepts `requireSignedURLs` in the POST body (boolean validation) and returns it in GET responses.
- `DomainRestrictionsModal` loads `requireSignedURLs` on mount, exposes a checkbox, and includes it in the save payload alongside `allowedOrigins`.
- Button label and modal title changed from "Domain Restrictions" to "Security".

**Decision rationale:** Minimal-touch approach — all changes are additive to existing plumbing. The toggle gives a quick way to test whether the LeaderPass platform handles signed-URL-locked videos without any permanent infrastructure change on the LP side.

**Alternatives considered:** (a) New separate modal — unnecessary; the checkbox fits naturally above the existing domain restrictions form. (b) Inline toggle directly in the panel without a modal — would require loading CF state eagerly for every ready asset; current modal lazy-loads on open.

**Commands run:** No build run (server lifecycle is user-managed). TypeScript validated at read time.

**Assumptions / follow-ups:** Enabling signed URLs will immediately break playback on LP until LP holds a CF signing key and mints tokens. Test by toggling on, loading the LP platform, and observing whether playback fails or succeeds. If it fails (expected), that confirms LP needs the signing-key integration. Toggle back off to restore playback.

---

## 2026-06-26 — Frame.io comment decoupling, Step 1: LPOS-native version resolution (comments no longer gated on Frame.io)

**User prompt:** "Let's assume we're going to finish all this on the production branch. I just ported over all the new player logic so we should be safe to complete our comment frame decoupling there." (Following a three-part audit that found the comment system's only hard chokepoints on Frame.io were: API/UI gating on `asset.frameio.assetId`, version resolution exclusively via `findAssetVersionByFrameioFileId`, the `frameio_comment_id ?? comment_id` identity flip, and comment count stored under `frameio.commentCount`. The mirror/webhook layer is already Frame.io-optional.)

**Summary:** First of a sequenced decoupling. Removed the Frame.io hard-gates in the comments API route and added an LPOS-native version resolver so an asset that was never uploaded to Frame.io can still be read/written for comments. Verified the prod tree already received the ported player components (`MediaPlayer.tsx` now present alongside `VideoTheaterMode`/`InlineVideoPlayer`).

**Files changed:**
- `app/api/projects/[projectId]/media/[assetId]/frameio/comments/route.ts` — (1) imported `getCurrentAssetVersion`; (2) added a `resolveCommentScope(projectId, assetId, fileId)` helper that returns `{projectId, assetId, assetVersionId}` from the Frame.io file-id mapping when a fileId exists, else from `getCurrentAssetVersion(assetId).asset_version_id`; (3) GET: removed the `if (!fileId) return {comments:[]}` gate and switched the default-version branch to `resolveCommentScope`; (4) POST: removed the `if (!fileId) 400 "not uploaded to Frame.io yet"` gate and switched version resolution to `resolveCommentScope`; (5) made the outbound top-level mirror enqueue conditional on `fileId` being present (LPOS-only assets keep comments local — the mirror worker can't post without a Frame.io file id anyway).
- `docs/project history.md` + `docs/changelog.json` — this log.

**Decision rationale:** A single shared resolver keeps GET and POST consistent and preserves existing Frame.io behaviour exactly (when a fileId exists, the file-id mapping still wins, so inbound webhook captures and outbound mirrors stay on the same version row). The LPOS-native fallback (`getCurrentAssetVersion`, which already existed but was never wired into the comment path) is the minimal enabler. Replies were already LPOS-only; this change extends the same "local-first" posture to top-level comments on non-Frame assets. Conditional enqueue avoids piling un-sendable jobs into the mirror queue for assets with no Frame.io target.

**Alternatives considered:** (a) Resolve the version inline in each handler — rejected, duplicates logic and risks GET/POST drift. (b) Always enqueue the mirror and let the worker no-op when there's no fileId — rejected; the worker would burn retries/backoff and eventually mark jobs abandoned (the `!` indicator), which is misleading for an asset that was never meant to be on Frame.io. (c) Rename the route off `/frameio/comments` now — deferred to a later step to avoid touching every caller mid-refactor.

**Commands run:** `npx tsc --noEmit` → exit 0, 0 errors. No build/dev run (server lifecycle is user-managed; prod runs live from this tree).

**Assumptions / follow-ups:** This is Step 1 of 4. Remaining: Step 2 — drop the UI gates (`{asset.frameio.assetId && …}` in MediaDetailPanel + the player components) so the compose/reply UI renders for non-Frame assets; Step 3 — stabilise comment identity on `comment_id` (retire the `frameio_comment_id ?? comment_id` flip that causes the reply-vanish race); Step 4 — move comment count off `frameio.commentCount` to a top-level field. Not yet runtime-verified against a live non-Frame asset — worth a manual check (open an asset that was never pushed to Frame.io and confirm comments load + post). Committed to prod, not pushed.

---

## 2026-06-26 — Frame.io comment decoupling, Step 2: drop the UI gates (comment UI renders for non-Frame assets)

**User prompt:** (Continuation of the production decoupling — Step 2 of the sequenced plan.)

**Summary:** Removed the `asset.frameio.assetId` / `frameioAssetId` render + handler gates so the comment UI (sidebar section, theater comments icon + panel + compose, version chips) appears and works for assets that were never uploaded to Frame.io. Pairs with Step 1's API change to make commenting on non-Frame assets fully functional end-to-end.

**Files changed:**
- `components/media/MediaDetailPanel.tsx` — (1) `fetchComments` now guards on `asset?.assetId` instead of `asset?.frameio.assetId`; (2) the open effect always calls `fetchVersions()` for any asset (was: only when on Frame.io); (3) the version-change effect fires on `asset?.assetId && selectedVersionId`; (4) the sidebar compose handler dropped the `!asset.frameio.assetId` bail; (5) the Comments section render gate `{asset.frameio.assetId && (…)}` is removed so the section always renders.
- `components/media/MediaPlayer.tsx` — dropped `frameioAssetId` from three theater gates: the comment compose handler, the comments-icon render (`isTheater && frameioAssetId` → `isTheater`), and the timed-comment compose footer. The comments panel itself was already gated on `panelContainer` (not Frame.io), so it needed no change. `frameioAssetId` remains a prop (now unused internally; harmless).
- `docs/project history.md` + `docs/changelog.json` — this log.

**Decision rationale:** The comments section is pure comment UI (header, version chips, list, compose) — no Frame.io-only review-link controls are bundled inside it — so unhiding it exposes nothing Frame.io-specific. Version discovery uses the LPOS-native `/versions` endpoint (`listAssetVersionsWithFrameioFileId`, which returns versions with null Frame.io ids), so the chips + per-version comment scoping work without Frame.io. The real-time socket listener (`frameio:comments:refresh`) was intentionally LEFT gated on `frameio.assetId` — those events only originate from Frame.io webhooks, so non-Frame assets have no external source to listen for (no behaviour lost).

**Alternatives considered:** (a) Gate the section on "asset has ≥1 version" instead of always rendering — rejected as unnecessary; an asset with no version just shows "No comments yet" and the compose 500s only in the narrow still-uploading window (noted as a follow-up). (b) Remove the `frameioAssetId` prop entirely — deferred; it's still threaded by callers and harmless, and removing it is churn better folded into a later cleanup.

**Commands run:** `npx tsc --noEmit` → exit 0, 0 errors. No build/dev run (prod runs live; server lifecycle is user-managed).

**Assumptions / follow-ups:** Step 2 of 4. The MediaTab grid comment-count badge is still gated on `asset.frameio.assetId` (non-Frame assets won't show a count chip in the grid) — that's covered by Step 4 (move count off `frameio.commentCount`). Edge: posting on an asset that has no asset_version yet (still uploading) returns 500 from the route — acceptable for now. Still to do: Step 3 (stable comment identity on `comment_id`) and Step 4 (comment-count relocation). Not yet runtime-verified — please open a never-uploaded-to-Frame asset and confirm the comments section appears, loads, and accepts a comment + reply in both the sidebar and theater. Committed to prod, not pushed.

---

## 2026-06-27 — Frame.io comment decoupling, Step 3: stable comment identity (comment_id is the sole outward id)

**User prompt:** "There are no videos that were never pushed to frame. Don't worry about breaking editpanel, we can fix that later. Design it properly" (chose the full 3b identity rework over the minimal reply-echo patch, accepting deferred EditPanel breakage).

**Summary:** Retired the dual-identity model where a comment's outward `id` was `frameio_comment_id ?? comment_id` and flipped from local→Frame.io once the outbound mirror landed. The outward `id` is now ALWAYS the stable local `comment_id`; the Frame.io comment id is surfaced as a separate explicit `frameioCommentId` field for the one consumer that still tethers on it (EditPanel review markers). This permanently kills the reply-vanish race (the optimistic insert's `c.id === parentId` match can no longer miss) and removes the last load-bearing Frame.io coupling from comment identity.

**Files changed:**
- `lib/store/media-comment-store.ts` — `ThreadedMediaComment` (and its `replies` sub-type) gain a required `frameioCommentId: string | null`. `getThreadedCommentsForAssetVersion` now sets `id = comment_id` for roots and replies, emits `frameioCommentId = frameio_comment_id ?? null`, and keys `rowLookup` by `comment_id` (so the route's `rowLookup.get(c.id)` author resolution still matches).
- `app/api/projects/[projectId]/media/[assetId]/frameio/comments/route.ts` — reply response `parentId` is now `parent.commentId` (was `frameioCommentId ?? commentId`); the reply-notification `commentId` is now `parent.commentId`; both POST responses (reply + top-level) carry `frameioCommentId`.
- `app/api/ep/projects/[projectId]/assets/[assetId]/comments/route.ts` — the "only mirrored comments" filter switched from the old id-flip trick (`lookup.commentId !== c.id`) to the explicit `c.frameioCommentId != null`; docstring documents the identity model + the deferred EditPanel-client follow-up.
- `app/api/webhooks/frameio/route.ts` — inbound reply-notification `commentId` now uses `parentLocal.commentId` instead of the Frame.io `data.parent_id`, so the notification reference is consistent with the new identity model.
- `docs/project history.md` + `docs/changelog.json` — this log.

**Decision rationale:** Overloading `id` to mean "Frame.io id if mirrored, else local id" was the root of the reply-vanish race and the dual-lookup band-aid (`getMediaCommentByEitherId`). Splitting it into a stable `id` (always `comment_id`) plus an explicit, nullable `frameioCommentId` gives clients one durable key while preserving the internal Frame.io tether for reconciliation (webhook idempotency on `frameio_comment_id UNIQUE` is untouched) and for EditPanel markers (which read the explicit field going forward). `getMediaCommentByEitherId` is intentionally KEPT — PATCH/DELETE still accept either id so cached pages / not-yet-updated clients holding old Frame.io ids keep working through the transition.

**Alternatives considered:** (a) Minimal 3a — just echo the client's `parentId` back from the reply POST — rejected by the user in favour of the proper rework. (b) Drop `frameio_comment_id` from the schema — wrong; it's still needed internally for outbound-mirror tethering, inbound-webhook idempotency, and EditPanel marker reconciliation. (c) Keep the EP route returning the Frame.io id as `id` (to avoid breaking EditPanel now) — rejected as inconsistent; the user explicitly accepted the EditPanel break, so the whole system now speaks one identity.

**Commands run:** `npx tsc --noEmit` → exit 0, 0 errors (run twice during the change). Verified no `frameio_comment_id ?? comment_id` / `frameioCommentId ?? commentId` outward-id patterns remain anywhere in app/ or lib/.

**Assumptions / follow-ups:** **EditPanel client follow-up (deferred, known break):** the editpanel app reads `id` for its `frameio:{id}` Resolve-marker tag — it must switch to reading `frameioCommentId`. Until it ships that change, existing markers won't match (the LPOS route now returns `comment_id` as `id`), and new marker placement keys off a value that's now the local id. This is the accepted break the user signed off on. Step 4 (move comment count off `frameio.commentCount` to a top-level field; fixes the MediaTab grid badge for non-Frame assets) is the remaining decoupling step. Not yet runtime-verified — worth confirming comment post/reply/complete/delete + the EditPanel comment pull still round-trip on a normal Frame-backed asset. Committed to prod, not pushed.

---

## 2026-06-27 — Frame.io comment decoupling, Step 4: comment count computed on read (off frameio.commentCount)

**User prompt:** "Explain the risk here - I'd always rather do the proper way" (chose the computed-on-read approach over the denormalised field, after I laid out the N+1 risk and the version-scoping semantics).

**Summary:** Final decoupling step. Replaced the drift-prone denormalised `asset.frameio.commentCount` with a per-asset count computed on read in a single batched query. While wiring it, found the count had NO rendered grid badge — its only consumer was MediaTab's "New Comment" toast detection, which was gated on `asset.frameio.assetId` (so non-Frame assets never toasted) and compared the denormalised value. Now the toast is driven by the computed, ungated count, and the denormalised write-paths are removed entirely.

**Files changed:**
- `lib/store/media-comment-store.ts` — new `getCommentCountByAssetForProject(projectId): Map<string,number>` — one `GROUP BY asset_id COUNT(*)` over non-deleted `media_comments` across all versions (same scoping as the existing `getLatestMediaCommentByAssetForProject`), so no N+1.
- `app/api/projects/[projectId]/media/route.ts` — GET now returns `commentCounts: Record<assetId, number>` alongside `latestComments`.
- `components/projects/MediaTab.tsx` — `fetchAssets` reads `data.commentCounts` (ungated) for both the baseline map and the new-comment toast comparison; dropped the `asset.frameio.assetId` gate and the `asset.frameio.commentCount` reads.
- `app/api/projects/[projectId]/media/[assetId]/frameio/comments/route.ts` — removed all four denormalised `frameio.commentCount` write-patches (GET latest-version sync, POST top-level +1, POST reply +1, DELETE −1); trimmed the now-unused `patchAsset` import.
- `app/api/webhooks/frameio/route.ts` — removed the inbound `comment.created` count increment; trimmed the now-unused `getAsset`/`patchAsset` imports.
- `lib/models/media-asset.ts` — `FrameIOInfo.commentCount` marked `@deprecated` (kept, defaults 0, to avoid churn across every FrameIOInfo construction site; flagged do-not-read).
- `docs/project history.md` + `docs/changelog.json` — this log.

**Decision rationale:** Computed-on-read is the source of truth and can never drift; the denormalised counter was updated across five code paths and was the kind of cruft that silently goes wrong on soft-deletes/version-switches. The N+1 risk (per-asset count query on a grid of N assets) is avoided by reusing the existing single-batched-aggregate pattern already proven by the latest-comment map. Count semantics = all non-deleted comments across all versions per asset, matching the recency aggregate so the two never disagree. Kept the deprecated model field rather than ripping it out of every construction site — that's pure churn with no functional gain and more blast radius on live prod.

**Alternatives considered:** (a) Keep a top-level denormalised `commentCount` patched on mutation — rejected; same drift class, just relocated. (b) Leave the dead write-paths in place — rejected; the user explicitly wanted the proper end-state, and dead maintenance code for an unread field is a future-dev trap. (c) Remove `FrameIOInfo.commentCount` entirely — deferred; broad type churn for no behavioural gain.

**Commands run:** `npx tsc --noEmit` → exit 0, 0 errors (run repeatedly through the change). Verified the now-unused `patchAsset`/`getAsset` imports were trimmed (grep usage counts) before the final clean typecheck.

**Assumptions / follow-ups:** **Decoupling Steps 1–4 are now COMPLETE** — Frame.io is optional for comments end to end: any asset can be commented on (Step 1+2), `comment_id` is the stable sole identity (Step 3), and counts are computed not denormalised (Step 4). Remaining cleanups (non-blocking): (a) the deferred EditPanel-client change to read `frameioCommentId` for its marker tether; (b) optionally rename the `/frameio/comments` route to `/comments`; (c) optionally remove the deprecated `FrameIOInfo.commentCount` field. None of Steps 1–4 are runtime-verified yet — recommend a smoke test on a normal Frame-backed asset (post/reply/complete/delete + new-comment toast) before relying on it. Committed to prod, not pushed.

---

## 2026-06-27 — Frame.io comment decoupling, Step 5 (cleanup): route rename + dead-code removal

**User prompt:** "Can you create a sub task to fix the editpanel comment system? Also, yes I would like to rename the routes and remove any dead frame.io code. Once that's all done we can push"

**Summary:** Final cleanup after the decoupling. (1) Renamed the comments route off the Frame.io-branded path, since it now reads local `media_comments`. (2) Removed the dead `FrameIOInfo.commentCount` field retired in Step 4. (3) Spawned a separate sub-task to fix the editpanel marker tether (the deferred Step-3 break).

**Files changed:**
- Renamed `app/api/projects/[projectId]/media/[assetId]/frameio/comments/route.ts` → `app/api/projects/[projectId]/media/[assetId]/comments/route.ts` (git mv; the sibling `frameio/route.ts` upload-trigger route stays put). Updated the moved file's header docstring + the `[frameio/comments …]` log tags.
- `components/media/MediaDetailPanel.tsx` — 6 fetch URLs updated `/frameio/comments` → `/comments`.
- `components/media/MediaPlayer.tsx` — 3 fetch URLs updated (only the URL strings; the concurrently-edited speed-hold work was untouched).
- `lib/models/media-asset.ts` — removed the deprecated `FrameIOInfo.commentCount` field and its `defaultFrameIO()` default. The canonical projection builds `frameio` via `...defaultFrameIO()`, so no other construction site referenced it (tsc confirmed zero source errors).
- `docs/project history.md` + `docs/changelog.json` — this log.

**Decision rationale:** The route was named `/frameio/comments` from when it proxied Frame.io; it now reads the local table, so the name was actively misleading. `git mv` preserves history. The `commentCount` field was genuinely dead after Step 4 (nothing reads it; computed-on-read replaced it) — removing it (vs. leaving the deprecated stub) was explicitly requested. EditPanel's marker-tether fix lives in a separate repo with its own auto-push workflow, so it's a spawned sub-task (task_cbd682fe) rather than an inline edit.

**Alternatives considered:** (a) Leave the route name — rejected; the user asked for the rename and the Frame.io brand is now wrong. (b) Keep the deprecated `commentCount` stub — rejected; user wanted dead code gone. (c) Broader Frame.io dead-code sweep — deliberately NOT done; the remaining `*ByFrameioId` store helpers and frameio service functions are still used (webhook reconciliation, mirror, shares), so removing them would break things. Only code made dead BY this decoupling was removed.

**Commands run:** `npx tsc --noEmit` → exit 0, 0 errors (after clearing a stale `.next/types` artifact that still referenced the old route path — a build-cache file, not source). Verified no remaining `frameio/comments` references in app/components/lib.

**Operational note — route move needs the server to pick up the new path:** because routing is file-based, the running prod server serves the OLD `/frameio/comments` path until it reloads the moved file (hot-reload if running via `tsx server.ts` dev-mode; a rebuild + restart if it's a production build). The frontend (now calling `/comments`) and backend (now serving `/comments`) deploy together from this tree, so they align on the user's next server reload/restart — but until that reload, the new frontend bundle would 404 against an un-reloaded old server. Coordinate the restart with the deploy.

**Assumptions / follow-ups:** Decoupling is functionally complete (Steps 1–5). Outstanding: the spawned editpanel sub-task (task_cbd682fe) must land so Resolve markers re-tether on `frameioCommentId`. User intends to push after this. Per workspace convention pushing is normally user-initiated; the user authorized the push here. Committed to prod.
