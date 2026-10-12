import type { Metadata } from 'next';
import { KnowledgeView } from '@/components/knowledge/KnowledgeView';

export const metadata: Metadata = { title: 'Wissen' };

export default function WissenPage() {
  return <KnowledgeView />;
}
