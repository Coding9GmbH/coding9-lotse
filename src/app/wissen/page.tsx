import type { Metadata } from 'next';
import { KnowledgeView } from '@/components/knowledge/KnowledgeView';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).nav.knowledge };
}

export default function WissenPage() {
  return <KnowledgeView />;
}
