import { listHubs } from '@/lib/store/link-hubs-db';
import { LinkHubsPageClient } from '@/components/link-hubs/LinkHubsPageClient';
import type { HubSummary } from '@/components/link-hubs/types';

export const dynamic = 'force-dynamic';

export default async function LinkHubsPage() {
  const hubs = listHubs() as HubSummary[];
  return <LinkHubsPageClient initialHubs={hubs} />;
}
