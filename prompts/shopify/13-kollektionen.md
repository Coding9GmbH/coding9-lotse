## Kollektionen (manuell und automatisch mit Regel)
Eine automatische Kollektion ist eine gespeicherte Regel („Tag = Keramik UND Preis < 50“); Shopify ordnet die passenden Produkte laufend selbst zu. Eine manuelle Kollektion ist eine feste, kuratierte Produktliste. Automatisch passt für Regeln, die sich mit dem Sortiment ändern sollen (Sale, Neuheiten, Preisklassen, Marke); manuell für eine Auswahl von Hand. Erkläre den Unterschied kurz, wenn der Nutzer ihn nicht kennt.
1. LESEN: search_categories/get_category zeigen Art, Regel, Sortierung und Produkte. Vor einer neuen Kollektion prüfen, ob es schon eine passende gibt.
2. REGEL KLÄREN: Bedingungen aus dem Wunsch ableiten (column TAG, TITLE, TYPE, VENDOR, VARIANT_PRICE, VARIANT_COMPARE_AT_PRICE, VARIANT_INVENTORY, VARIANT_TITLE, IS_PRICE_REDUCED; relation EQUALS, NOT_EQUALS, CONTAINS, GREATER_THAN, LESS_THAN …; disjunctive=true = ODER). Werte so schreiben, wie sie im Shop vorkommen (Tags, Vendor, Typ aus list_products).
3. TREFFER PRÜFEN mit preview_collection_rules, BEVOR du vorschlägst: 0 Treffer oder unerwartet viele → mit dem Nutzer nachschärfen. Nicht jede Regel lässt sich vorab zählen; das dann sagen.
4. BESTÄTIGEN per ask_user: lesbare Regel + Trefferzahl + 2 bis 3 Beispiele + Name, ob sie gleich im Online Store sichtbar sein soll (publish).
5. VORSCHLAGEN mit propose_collection (neu: name, rules oder productIds, optional description, SEO, sortOrder, publish; bestehende automatische: id + rules und/oder sortOrder, die Regel wird komplett ersetzt). Eine manuelle Kollektion lässt sich nicht in eine automatische umwandeln.
6. PRODUKTE ZUORDNEN in manuellen Kollektionen mit propose_collection_products (add/remove). In automatische Kollektionen kommen Produkte nur über ihre Daten (z. B. Tag ergänzen).
7. TEXTE, SEO, SICHTBARKEIT, SORTIERUNG bestehender Kollektionen mit propose_category_changes.
Nach der Freigabe das tatsächliche Ergebnis melden und die Rückgängig-Möglichkeit erwähnen.
