# Zweiter Durchgang
- Datum: 2026-10-12
- Stand: Commit c5f074c, Branch main
- Methode: Die zwei schärfsten Befunde aus Dokument 01, 03 und 08 am genannten Quelltext nachgelesen. Kein Server, kein Shop, kein Browser.

## Urteil
Beide Befunde halten. Die Ampel rot aus Sicherheit und Korrektheit bleibt. Die Schwere des Bestandsfehlers ist hoch, nicht kritisch: er braucht einen fehlgeschlagenen Bestandsaufruf nach einem gelungenen Schreiben. Kritisch wirkt er, weil die Karte die schon geschriebenen Zeilen als fehlgeschlagen zeigt und Rückgängig sie nicht enthält.

## Nachgelesen

### read_page hängt die öffentliche URL roh an die interne Basis
- Ort: src/server/platform/openmage/tools.ts:133 und src/server/platform/magento/tools.ts:145
- Beleg: `assertShopUrl` vergleicht nur `u.origin` (src/server/storefront.ts:107-112). Danach gilt `u.href.startsWith(ro().publicUrl)` ohne Schnitt an `/`, `?` oder Ende. Der Rest wird an `ro().base` gehängt. `redirect: 'follow'` steht in der nächsten Zeile, ohne Prüfung der Endadresse.
- Beispiel, das die Zeile hergibt: öffentliche URL `https://shop.example.com/de`, interne Basis `http://172.17.0.2`, gelesene URL `https://shop.example.com/de@169.254.169.254/latest/meta-data`. Die Origin bleibt `https://shop.example.com` und besteht die Prüfung. Der zusammengesetzte String ist `http://172.17.0.2@169.254.169.254/latest/meta-data`. Der Host dieser URL ist `169.254.169.254`.
- Grenze: Ohne Pfad in der öffentlichen URL bleibt der Rest ein Pfad auf der internen Basis. Der Platzhalter in den Einstellungen ist `https://mein-shop.de` (src/lib/platforms.ts:105 und :129). Die Demo-Konfiguration aus der README (Shopware intern `http://shopware`, öffentlich `http://localhost:8888`) trifft den Pfad nicht. Magento und OpenMage in einem Unterverzeichnis oder mit `/index.php` in der öffentlichen URL treffen ihn. Nichts im gelesenen Speicher schneidet den Pfad ab.
- Vertrauen: sicher für die Verkettung. Ob `fetch` im Container die Metadaten-Adresse erreicht, ist nicht gelaufen.

### Produkt-Set auf Magento 2 und OpenMage verliert Rückgängig, wenn der Bestand scheitert
- Ort: src/server/platform/magento/catalog.ts:179-201 und src/server/platform/openmage/catalog.ts:178-192
- Beleg: `applyProduct` schreibt Name und Preis über `writeScoped`, bevor der Bestand gesetzt wird. Die Rückgängig-Schritte liegen in einer lokalen Variable und werden erst mit `return undo` nach außen gegeben. Wirft der Bestand, erreicht die Funktion dieses `return` nicht. Magento übernimmt im `catch` von `applyGrouped` nur `e.undo`. Der Bestandsfehler hängt kein `undo` an. Der Kommentar in catalog.ts:201 trifft auf `assertPriceInView` (catalog.ts:167) zu, das `{ undo }` an den Fehler hängt, und nicht auf den Bestand. OpenMage liest `e.undo` im `catch` gar nicht (catalog.ts:192) und setzt jede Zeile des Produkts auf `ok: false`.
- Zwei unabhängige Reviews (03-korrektheit.md B1, 08-zuverlaessigkeit.md B1) beschreiben denselben Pfad. Die Schwere dort ist hoch bzw. kritisch. Dieser Durchgang lässt sie bei hoch, mit dem Zusatz, dass die Karte den falschen Stand zeigt.
- Vertrauen: sicher

### Zusätzlich gegengelesen, nicht als neuer Befund
- Shopify-Rabatte verwerfen die Zeilenauswahl: `reg.register('promotion', … _sel …)` in src/server/platform/shopify/index.ts:56. Das stützt 03-korrektheit.md B2.
- Der Satz „Alles bleibt lokal in Lotse.“ steht in src/components/knowledge/KnowledgeView.tsx:52. Das stützt 07-datenschutz.md B1.

## Nicht nachgelesen
Die übrigen Befunde der zehn Dokumente. Insbesondere nicht: Galerie-URLs in openmage/images.ts, der OpenMage-Kern bei `target_path`, ob ein Timeout nach dem Commit der Gegenseite kommt, und jeder Viewport.

## Für einen Fix
Zuerst die Verkettung in `read_page` (Pfadgrenze und `redirect: 'manual'`) und das Hängen der schon geschriebenen Schritte an den Bestandsfehler auf Magento und OpenMage. Die Karte darf eine geschriebene Zeile nicht als fehlgeschlagen zeigen, wenn kein Rückgängig-Schritt existiert.
