import { redirect } from 'next/navigation';

// Collections have been consolidated — use the queue tray for status info.
export default function MediaCollectionsPage() {
  redirect('/media');
}
