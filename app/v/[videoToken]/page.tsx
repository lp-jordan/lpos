import { ShareViewer } from '@/components/share/ShareViewer';

export const dynamic = 'force-dynamic';

export default async function ShareVideoPage({ params }: { params: Promise<{ videoToken: string }> }) {
  const { videoToken } = await params;
  return <ShareViewer source={{ kind: 'video', token: videoToken }} />;
}
