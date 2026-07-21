import { SilentPage } from '@/components/silent/SilentPage';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Place' };

export default function SilentPlacePage() {
  return <SilentPage slug="place" />;
}
