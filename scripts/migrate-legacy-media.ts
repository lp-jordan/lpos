import { getCanonicalAssetDbPath } from '@/lib/store/canonical-asset-db';
import { migrateAllLegacyProjects } from '@/lib/store/canonical-asset-store';

const results = migrateAllLegacyProjects();

console.log(`Canonical DB: ${getCanonicalAssetDbPath()}`);
for (const result of results) {
  console.log(`${result.projectId}: ${result.assetCount} asset(s) available in canonical store`);
}
