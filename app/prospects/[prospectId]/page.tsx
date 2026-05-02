import { redirect } from 'next/navigation';

export default async function ProspectDetailRedirect({
  params,
}: {
  params: Promise<{ prospectId: string }>;
}) {
  const { prospectId } = await params;
  redirect(`/people/${prospectId}`);
}
