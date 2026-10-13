import type { Metadata } from 'next';
import { SettingsView } from '@/components/settings/SettingsView';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).settings.title };
}

export default function SettingsPage() {
  return <SettingsView />;
}
