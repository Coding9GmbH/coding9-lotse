import 'server-only';
// OpenMage: sales per product (PlatformAdapter.sales) via GET /v1/sales of the Lotse module (1.3.0+), with the privileged client.
// The module aggregates in SQL and only returns product_id, qty, revenue and orders per product: no single orders, no customers.
// The AI's read client (reader.ts) denies the path; the whole shop counts (no store scope).
import type { SalesRange, SalesReport } from '../types';
import { OmError, type OmClient } from './client';

export const MODULE_SALES = '1.3.0';
const TOO_OLD = `Das OpenMage-Modul Lotse_Connector ist zu alt für den Abverkauf: bitte auf Version ${MODULE_SALES} aktualisieren (integrations/openmage).`;
interface OmSales { currency: string | null; orders: number; capped: boolean; rows: { product_id: number; qty: number; revenue: number; orders: number }[] }

export async function openmageSales(c: OmClient, r: SalesRange): Promise<SalesReport> {
  let d: OmSales;
  try { d = await c.req('GET', '/v1/sales', undefined, { query: { from: r.from, to: r.to } }); }
  catch (e) { if (e instanceof OmError && e.status === 404 && e.code !== 'disabled') throw new Error(TOO_OLD); throw e; }
  return {
    rows: (d?.rows ?? []).map(x => ({ productId: String(x.product_id), quantity: Number(x.qty) || 0, revenue: Math.round((Number(x.revenue) || 0) * 100) / 100, orders: Number(x.orders) || 0 })),
    orders: Number(d?.orders) || 0, currency: d?.currency ?? null, capped: !!d?.capped,
    ...(d?.currency === null ? { notes: ['Bestellungen in mehreren Basiswährungen: Umsätze sind ohne Umrechnung addiert.'] } : {}),
  };
}
