import { redirect } from 'next/navigation';

// Intake has been consolidated into the per-project Media tab.
export default function MediaIntakePage() {
  redirect('/media');
}
