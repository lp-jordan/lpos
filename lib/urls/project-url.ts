/**
 * Single source of truth for project-related URLs.
 *
 * URL hierarchy (the team calls the whole segment "Projects" even though
 * the entry point lists clients):
 *
 *   /projects                                           clients grid
 *   /projects/clients/<clientName>                      that client's projects
 *   /projects/clients/<clientName>/<projectId>          project page
 *   /projects/clients/<clientName>/<projectId>/<sub>    project sub-route
 *
 * Old /projects/<projectId>/<sub> URLs still work via redirect shims —
 * kept indefinitely so existing bookmarks / external links don't 404.
 */

export function clientProjectsHref(clientName: string): string {
  return `/projects/clients/${encodeURIComponent(clientName)}`;
}

export function projectHref(clientName: string, projectId: string, sub?: string): string {
  const base = `${clientProjectsHref(clientName)}/${projectId}`;
  return sub ? `${base}/${sub}` : base;
}
