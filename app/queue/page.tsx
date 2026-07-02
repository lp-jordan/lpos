import { cookies } from 'next/headers';
import { QueueView } from '@/components/queue/QueueView';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';

export default async function QueuePage() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const isAdmin = session?.role === 'admin';

  return (
    <section className="queue-page">
      <QueueView isAdmin={isAdmin} />
    </section>
  );
}
