import { getAsset } from '@/lib/store/media-registry';
import { getSilentPageSelection } from '@/lib/store/silent-pages-store';
import { SILENT_PAGE_LABELS, type SilentPageSlug } from '@/lib/silent-pages';
import { SilentLoopPlayer } from './SilentLoopPlayer';

/**
 * Server-rendered shell for a silent page. Resolves the admin-selected asset
 * straight from SQLite (no client fetch, so the screen shows video on first
 * paint) and hands the stream URL to the client player.
 *
 * Unlisted by design: these routes are in no nav config and are reachable only
 * by direct URL. They still sit behind normal LPOS session auth — `middleware.ts`
 * gates everything not in `isPublicPath()`, and these are not listed there.
 */
export function SilentPage({ slug }: { slug: SilentPageSlug }) {
  const selection = getSilentPageSelection(slug);
  const asset = selection ? getAsset(selection.projectId, selection.assetId) : null;

  if (!selection) {
    return (
      <div className="silent-page-message">
        <p>No asset selected for {SILENT_PAGE_LABELS[slug]}.</p>
        <p className="silent-page-message-sub">
          Choose one in Settings → Media → Silent pages.
        </p>
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="silent-page-message">
        <p>The selected asset is no longer available.</p>
        <p className="silent-page-message-sub">
          It may have been deleted or moved. Pick another in Settings → Media → Silent pages.
        </p>
      </div>
    );
  }

  const src = `/api/projects/${selection.projectId}/media/${selection.assetId}/stream`;
  return <SilentLoopPlayer src={src} />;
}
