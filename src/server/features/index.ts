import 'server-only';
// Register aller Feature-Module. Jedes Modul registriert seine Applier (registerApplier) und Shop-Prüfungen (registerCheck) beim Import.
// Feature.platforms wählt die Plattform: ['shopware'] (liest über session.sw) oder 'all' (Kern, nur session.lookup). Reihenfolge = Werkzeug-Reihenfolge.
import type { Feature } from './types';
import { bilder } from './bilder';
import { seo } from './seo';
import { stammdaten } from './stammdaten';
import { hersteller } from './hersteller';
import { sprachen } from './sprachen';
import { varianten } from './varianten';
import { streams } from './streams';
import { promotionen } from './promotionen';
import { shopcheck } from './shopcheck';
import { recht } from './recht';
import { importFeature } from './import';
import { gsc } from './gsc';
import { sistrix } from './sistrix';
import { wissen } from './wissen';

export const FEATURES: Feature[] = [
  bilder,
  seo,
  stammdaten,
  hersteller,
  sprachen,
  varianten,
  streams,
  promotionen,
  shopcheck,
  recht,
  importFeature,
  gsc,
  sistrix,
  wissen,
];
