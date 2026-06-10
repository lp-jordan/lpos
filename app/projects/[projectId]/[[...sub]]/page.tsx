import { redirect, notFound } from 'next/navigation';
import { getProjectById } from '@/lib/selectors/projects';
import { projectHref } from '@/lib/urls/project-url';

/**
 * Compatibility redirect for the old project URL shape.
 *
 *   /projects/<projectId>             → /projects/clients/<clientName>/<projectId>
 *   /projects/<projectId>/<sub>       → /projects/clients/<clientName>/<projectId>/<sub>
 *   /projects/<projectId>/<a>/<b>     → /projects/clients/<clientName>/<projectId>/<a>/<b>
 *
 * Bookmarks, external links (notifications, emails), and integrations that
 * predate the client-prefixed URL keep working. Kept indefinitely.
 *
 * The query string is preserved so asset deep-links like
 * `/projects/<id>?assetId=<asset>` still open the asset sidebar after the
 * redirect — MediaTab reads `?assetId=` to drive `setSelectedAsset`. (URL
 * hash fragments are not sent to the server, so the browser carries those
 * across the redirect on its own.)
 */
export default async function ProjectRedirectShim({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ projectId: string; sub?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { projectId, sub } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const subPath = sub && sub.length > 0 ? sub.join('/') : undefined;
  const target = projectHref(project.clientName, projectId, subPath);

  const sp = await searchParams;
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, v);
    } else {
      usp.append(key, value);
    }
  }
  const qs = usp.toString();
  redirect(qs ? `${target}?${qs}` : target);
}
