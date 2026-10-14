import 'server-only';
// Register aller Feature-Module. Jedes Modul registriert seine Applier (registerApplier) und Shop-Prüfungen (registerCheck) beim Import.
// Feature.platforms wählt die Plattform: ['shopware'] (liest über session.sw) oder 'all' (Kern, nur session.lookup). Reihenfolge = Werkzeug-Reihenfolge.
import type { Feature } from './types';
import { productImages } from './product-images';
import { seo } from './seo';
import { productData } from './product-data';
import { manufacturers } from './manufacturers';
import { translations } from './translations';
import { variants } from './variants';
import { streams } from './streams';
import { promotions } from './promotions';
import { shopcheck } from './shopcheck';
import { legal } from './legal';
import { importFeature } from './import';
import { gsc } from './gsc';
import { sistrix } from './sistrix';
import { siteCheck } from './site-audit';
import { knowledgeBase } from './knowledge-base';

export const FEATURES: Feature[] = [
  productImages,
  seo,
  productData,
  manufacturers,
  translations,
  variants,
  streams,
  promotions,
  shopcheck,
  legal,
  importFeature,
  gsc,
  sistrix,
  siteCheck,
  knowledgeBase,
];
