import { ShareViewer } from '@/components/share/ShareViewer';

export const dynamic = 'force-dynamic';

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ShareViewer source={{ kind: 'share', token }} />;
}
