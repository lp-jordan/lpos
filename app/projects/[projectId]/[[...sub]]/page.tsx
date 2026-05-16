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
 */
export default async function ProjectRedirectShim({
  params,
}: Readonly<{ params: Promise<{ projectId: string; sub?: string[] }> }>) {
  const { projectId, sub } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const subPath = sub && sub.length > 0 ? sub.join('/') : undefined;
  redirect(projectHref(project.clientName, projectId, subPath));
}
