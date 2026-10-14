import type { Metadata } from 'next';
import { SettingsView } from '@/components/settings/SettingsView';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = (await getMessages()).settings;
  return { title: `${t.title} · ${t.sections.logs.nav}` };
}

export default function SettingsPage() {
  return <SettingsView section="logs" />;
}
