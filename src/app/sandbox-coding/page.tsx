import type { Metadata } from 'next';
import { SandboxView } from '@/components/sandbox/SandboxView';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).sandbox.title };
}

export default function SandboxCodingPage() {
  return <SandboxView />;
}
