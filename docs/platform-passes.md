# Platform tab — Pass composition & tile-background studio

Living spec for the `/platform` section. Status: **Phases 1–2 shipped** — staging model, dedicated per-pass routes, composition board, deterministic tile backgrounds, multi-brand (5 presets + per-pass custom colours), per-tile grain, drag reorder, and media linking. Phase 3+ next.

## Purpose

The Platform tab is the bridge between LPOS (our media home) and the **LeaderPass admin backend** (source of truth for what passes exist, their category/tile structure, tile↔media associations, and metadata). LPOS is **not** the source of truth. This section is a **staging + preparation + export** surface: compose a pass, link LPOS media to tiles, generate tile background art, enrich with Pass Prep, then hand the finished template off to LP admin.

Two hard constraints shape everything:
1. **LeaderPass admin stays the boss.** Anything authored here is provisional until it is reflected into / exported to LP admin.
2. **Don't duplicate the projects pages.** Tiles *reference* project-owned media assets; the Platform tab never re-uploads or re-manages media.

## Governing principle — separate ART from STRUCTURE

- **Structure** (which tiles, in which category, ordering, titles) → LeaderPass owns it (eventually). LPOS holds a *staging* copy, designed to later bind to / reflect LP entities.
- **Art** (a tile's background image) → LPOS owns it, durably. Art is bound to the **media asset** (video), and already has a delivery path to LeaderPass via the existing `asset.cloudflare.posterUrl` → publish push.

Because the durable thing (art on a video) is decoupled from the volatile thing (structure), nothing built while disconnected is thrown away when LP connection lands.

## The object: a staging Pass

The whole section hangs off one object — a **Pass** — moving through a pipeline. "Design New Pass" → "Link New Pass" and "Export" → "Push" are the *same skeleton* with the LeaderPass connection swapped in.

```
Pass ── Category[] ── Tile[]
```

**Lifecycle status:** `draft → composed → linked → enriched → exported → synced`

| Stage | What happens | Now (disconnected) | Later (LP connected) |
|-------|--------------|--------------------|-----------------------|
| Create | A pass exists | **Design New Pass** (manual) | **Link New Pass** (enumerated from LP) |
| Compose | Categories + tiles | Manual board | Reflected from LP structure |
| Link | Tile ← LPOS media | Reference a project asset (video / link-out / PDF) | Same |
| Design | Tile background art | Generate + tweak (Tile Studio engine) | Same |
| Enrich | Titles/descriptions | **Pass Prep** run over linked-tile transcripts | Same, auto |
| Export | Hand-off package | Manifest + zip of background PNGs → paste into LP admin | Becomes a push |

## Section structure (routes & views)

- `/platform` — **Passes list** (landing). Cards with pipeline status. Button: *Design New Pass* (now) → *Link New Pass* (later).
- `/platform` → **Pass workspace** (in-page view once a pass is opened) — the board: categories + tiles (ported from the Tile Studio prototype). Per tile: link media, generate background, edit title/description, see Pass Prep output. Header: title, status, brand, grain finish, **Export**.
- **Analytics** (later) — Cloudflare Stream data per linked video, scoped by pass (read-only first). This was the original "pass analytics dashboard" idea, now living *inside* the pass object.

## Data model (staging — `data/platform.sqlite`, self-contained for portability)

Isolated in its own SQLite file + store module (`lib/store/platform-pass-store.ts`) so the whole section can later be lifted OFF LPOS (security) and the tab becomes a link-out. Reserved `lp_*_id` columns bind a staging row to a real LP entity on reflect.

- `platform_passes` (id, title, source `local|leaderpass`, lp_pass_id?, status, brand, brand_config?, created_at, updated_at)
- `platform_categories` (id, pass_id→passes, title, position, created_at) — `ON DELETE CASCADE`
- `platform_tiles` (id, category_id→categories, title, description, position, lp_tile_id?, media_asset_id?, media_project_id?, media_kind `video|link|pdf`?, media_title?, media_thumb_url?, link_url?, archetype, palette_index, seed, grain, background_ref?, duration_sec?, created_at, updated_at) — `ON DELETE CASCADE`

`brand_config` is a per-pass JSON of `BrandConfig` overrides (custom accents/duotone/line) merged over the named brand. `media_asset_id`/`media_project_id` **reference** a project-owned asset — never a copy; `media_title`/`media_thumb_url`/`duration_sec` are cached at link time for display. `background_ref` will hold the Cloudflare Images URL once art is persisted (Phase 3); until then backgrounds render client-side from `(archetype, palette_index, seed, grain, brand)`. New columns are added to existing DBs via `ensureColumn` migrations.

## Tile background engine

`lib/platform/tile-background.ts` — deterministic, seeded SVG generator (ported from the Tile Studio prototype). Archetypes: `gradient`, `geometric`, `duotone` (procedural stand-in for a real photo remapped to a two-colour brand duotone), `hero` (bespoke slot). Multi-brand config (`BRANDS`). `deriveRecipe(title, description, brand)` maps a tile's words → `{archetype, paletteIndex, seed, stockQuery}`. Used client-side to render and server-side to seed a tile's defaults on create. Grain/blur are finish options.

## Phased plan

- **Phase 1 (done):** staging model + store + API; Passes list + Pass workspace board (create/edit/delete categories & tiles); client-side tile backgrounds + inspector (generate-from-description, archetype/palette/grain/shuffle).
- **Phase 1.1 (done):** dedicated per-pass routes (`/platform/[passId]`); large-name + data-row header; Brand modal (5 presets + per-pass custom colours via `brand_config`); grain moved per-tile (default subtle); drag reorder of tiles (within/across categories) and categories; new tiles auto-varied; right-justified category controls; Save-draft near Export; no auto-open of the inspector on tile create.
- **Phase 2 (done):** link media — attach a project asset (video) or an external URL to a tile via a media picker (`/api/platform/media/*`, `/api/platform/tiles/:id/media`); caches title/duration/thumbnail; shown in the board footer + inspector. Tiles reference the asset; media is never copied.
- **Phase 3 (next):** persist background art — render tile background → Cloudflare Images → `background_ref`, reusing the `batch-poster` seam so it can flow into the LeaderPass push as the tile thumbnail.
- **Phase 4:** Export package — structure manifest + zip of background PNGs.
- **Phase 5:** move Pass Prep here — run over the transcripts of linked tiles instead of the project-side manual picker.
- **Phase 6:** per-pass Cloudflare analytics.
- **Phase 7:** LeaderPass connection — `source='leaderpass'`, enumerate/reflect passes, bind `lp_*_id`, Export → Push.

## "May move off LPOS"

The section is deliberately self-contained (own DB file, own store module, own `/api/platform/*` namespace) so it can be extracted into a standalone gated service later — at which point this tab becomes a link-out. See [[project_platform_quarantine]] for that direction.
