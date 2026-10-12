import { z } from 'zod';

// Kennungen aller Plattformen: Shopware 32-hex, Shopify/Magento/OpenMage numerisch bzw. gid://shopify/Product/123; ohne Leer- und Steuerzeichen
export const linkIdSchema = z.string().trim().min(1).max(64).regex(/^[^\s\u0000-\u001f\u007f]+$/);
export const linkSchema = z.object({ kind: z.enum(['product', 'category']), id: linkIdSchema, number: z.string().max(100).nullish(), name: z.string().max(200).nullish() });
