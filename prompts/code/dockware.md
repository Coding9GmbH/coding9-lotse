## Vorlage: Shopware 6 (Dockware)
Der Test-Shop ist ein vollständiges Shopware 6 im Container. Das Repository ist ein {{layoutKind}} namens {{pluginName}}; es liegt im Container unter {{containerPath}} (www-data, Shopware-Wurzel /var/www/html, dort startet sandbox_bash).

Aufbau eines Shopware-Plugins/-Themes:
- Storefront-Templates: src/Resources/views/storefront/… – sie erweitern die Templates von Shopware mit `{% sw_extends '@Storefront/storefront/<gleicher Pfad>' %}` und überschreiben einzelne Blöcke (`{% block name %}…{{ parent() }}…{% endblock %}`). Lege die Datei unter demselben relativen Pfad an wie das Original (z. B. layout/header/header.html.twig, layout/footer/footer.html.twig, page/product-detail/index.html.twig). Blocknamen nur verwenden, wenn du sie kennst oder im Shop gesehen hast (read_sandbox_page mit format html zeigt das gerenderte Markup); im Zweifel einen äußeren Block erweitern und `{{ parent() }}` behalten.
- Styles: src/Resources/app/storefront/src/scss/ (base.scss für eigene Regeln, overrides.scss für Bootstrap-/Theme-Variablen vor dem Kompilieren). Shopware-Variablen wie $sw-color-brand-primary verwenden.
- JavaScript: src/Resources/app/storefront/src/main.js und eigene JS-Plugins. Shopware lädt davon nur das gebaute Ergebnis (src/Resources/app/storefront/dist/storefront/js/<plugin-name-kebab>/…), das theme:compile einbindet. Bauen geht nur mit bin/build-storefront.sh, und das lädt beim ersten Lauf npm-Pakete aus dem Internet (ohne Freigabe bricht es mit EAI_AGAIN ab) – lieber ohne JS lösen; wenn JS nötig ist, erst request_internet.
- Theme: src/Resources/theme.json (views, style, script, asset, config.fields). Nach Änderungen daran: bin/console theme:refresh, dann theme:compile.
- Texte: src/Resources/snippet/<locale>/*.json; in Twig `{{ 'schluessel'|trans }}`.
- PHP (Plugin-Klasse, Subscriber, services.xml) nur ändern, wenn nötig; danach php -l <Datei> und bin/console cache:clear.

## Plugin-Entwicklung
Aufbau eines Plugins (alle Pfade relativ zur Repository-Wurzel = Plugin-Ordner):
- composer.json: "name" (vendor/paket, klein), "type": "shopware-platform-plugin", "version", "license", "description", "require": {"shopware/core": "~6.7.0"} (bei Storefront-Teilen auch "shopware/storefront"), "autoload": {"psr-4": {"<Namespace>\\": "src/"}}, "extra": {"shopware-plugin-class": "<Namespace>\\<Klassenname>", "label": {"de-DE": "…", "en-GB": "…"}}. Der Klassenname ist der technische Name des Plugins.
- src/<Klassenname>.php: `namespace <Namespace>; use Shopware\Core\Framework\Plugin; class <Klassenname> extends Plugin {}` (install/uninstall/activate nur bei Bedarf überschreiben).
- src/Resources/config/services.xml: eigene Services, Subscriber (`<tag name="kernel.event_subscriber"/>`), Controller, Befehle. Nur anlegen, wenn es Services gibt.
- src/Resources/config/config.xml: Einstellungen des Plugins in der Administration (Felder mit name, label, defaultValue); in Twig `config('<Klassenname>.config.<feld>')`, in PHP über SystemConfigService.
- src/Migration/Migration<Zeitstempel><Name>.php: Datenbankänderungen (extends MigrationStep, getCreationTimestamp, update). Ausführen: bin/console database:migrate --all <Klassenname> (bzw. beim Installieren automatisch).
- src/Resources/views/storefront/…: Twig-Erweiterungen wie oben; src/Resources/snippet/…: Texte.
- src/Resources/app/storefront/src: Storefront-SCSS (scss/base.scss wird von theme:compile kompiliert) und JS (braucht ein Build, siehe oben).
- src/Resources/app/administration/src: Erweiterungen der Administration (main.js, Module). Bauen nur mit bin/build-administration.sh – das braucht wie das Storefront-Build Internet für npm (offline bleibt es hängen); vorher request_internet und dem Nutzer sagen, dass das erste Build mehrere Minuten dauert.

Installieren und wirksam machen (sandbox_bash, in /var/www/html; der Plugin-Ordner wird vorher automatisch übertragen):
1. bin/console plugin:refresh – das Plugin muss in der Liste erscheinen (sonst composer.json prüfen: type, extra.shopware-plugin-class, autoload).
2. bin/console plugin:install --activate <Klassenname> (danach nach Änderungen an composer.json oder services.xml: bin/console plugin:update <Klassenname> bzw. cache:clear).
3. Wirksam machen: bin/console cache:clear; nach Templates, SCSS oder Theme-Änderungen bin/console theme:compile && bin/console cache:clear – cache:clear zuletzt (in umgekehrter Reihenfolge blieb ein neu angelegtes Template eines frisch installierten Plugins im Test unsichtbar). Zeigt sich ein neues Template trotzdem nicht, cache:clear noch einmal ausführen.
4. Prüfen: bin/console plugin:list | grep <Klassenname> (Installed/Active = Yes), read_sandbox_page auf der betroffenen Seite, bei Fehlern tail -n 50 var/log/*.log. Bei Migrationen bin/console database:migrate --all <Klassenname>; Backend-Logik mit einem eigenen bin/console-Befehl oder curl auf die Store-API des Test-Shops prüfen.

Befehle (sandbox_bash, in /var/www/html): bin/console theme:compile (ca. 10 s; danach lädt die Vorschau neu), bin/console cache:clear, bin/console theme:refresh, bin/console plugin:refresh, bin/console lint:twig {{containerPath}}/src/Resources/views/…, php -l <Datei>, tail -n 50 var/log/*.log, mysql -uroot -proot -h127.0.0.1 shopware -e '…'.
Prüfen: read_sandbox_page("/") für die Startseite; Kategorie-, Produkt- und Warenkorbseiten über ihre Pfade (Links aus dem HTML der Startseite übernehmen).
