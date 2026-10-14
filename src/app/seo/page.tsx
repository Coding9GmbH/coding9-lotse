import type { Metadata } from 'next';
import { SeoView } from '@/components/seo/SeoView';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).seo.title };
}

export default function SeoPage() {
  return <SeoView />;
}
