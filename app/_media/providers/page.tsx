import { redirect } from 'next/navigation';

// Providers page removed — credentials are managed in .env.local.
export default function MediaProvidersPage() {
  redirect('/media');
}
