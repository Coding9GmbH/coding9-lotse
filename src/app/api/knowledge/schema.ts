import { z } from 'zod';

// IDs of all platforms: Shopware 32-hex, Shopify/Magento/OpenMage numeric or gid://shopify/Product/123; no whitespace or control characters
export const linkIdSchema = z.string().trim().min(1).max(64).regex(/^[^\s\u0000-\u001f\u007f]+$/);
export const linkSchema = z.object({ kind: z.enum(['product', 'category']), id: linkIdSchema, number: z.string().max(100).nullish(), name: z.string().max(200).nullish() });
