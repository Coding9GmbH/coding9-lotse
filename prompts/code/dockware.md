## Vorlage: Shopware 6 (Dockware)
Der Test-Shop ist ein vollständiges Shopware 6 im Container. Das Repository ist ein {{layoutKind}} namens {{pluginName}}; es liegt im Container unter {{containerPath}} (www-data, Shopware-Wurzel /var/www/html). Pfade in den Werkzeugen sind immer relativ zur Repository-Wurzel.

Aufbau eines Shopware-Plugins/-Themes:
- Storefront-Templates: src/Resources/views/storefront/… – sie erweitern die Templates von Shopware mit `{% sw_extends '@Storefront/storefront/<gleicher Pfad>' %}` und überschreiben einzelne Blöcke (`{% block name %}…{{ parent() }}…{% endblock %}`). Lege die Datei unter demselben relativen Pfad an wie das Original (z. B. layout/header/header.html.twig, layout/footer/footer.html.twig, page/product-detail/index.html.twig). Blocknamen nur verwenden, wenn du sie kennst oder im Shop gesehen hast (read_sandbox_page mit format html zeigt das gerenderte Markup); im Zweifel einen äußeren Block erweitern und `{{ parent() }}` behalten.
- Styles: src/Resources/app/storefront/src/scss/ (base.scss für eigene Regeln, overrides.scss für Bootstrap-/Theme-Variablen vor dem Kompilieren). Shopware-Variablen wie $sw-color-brand-primary verwenden.
- JavaScript: src/Resources/app/storefront/src/main.js und eigene Plugins (JS-Änderungen brauchen ein Build, das hier nicht verfügbar ist – lieber ohne JS lösen).
- Theme: src/Resources/theme.json (views, style, script, asset, config.fields). Nach Änderungen daran: run_command theme-refresh, dann theme-compile.
- Texte: src/Resources/snippet/<locale>/*.json; in Twig `{{ 'schluessel'|trans }}`.
- PHP (Plugin-Klasse, Subscriber, services.xml) nur ändern, wenn nötig; danach run_command php-lint mit args.path und cache-clear.

Befehle (run_command): theme-compile (Theme kompilieren, ca. 10 s; danach lädt die Vorschau neu), cache-clear, theme-refresh, plugin-refresh, lint-twig (args.path = Twig-Datei relativ zur Plugin-Wurzel, z. B. src/Resources/views/storefront/layout/header/header.html.twig), php-lint (args.path = PHP-Datei).
Prüfen: read_sandbox_page("/") für die Startseite; Kategorie-, Produkt- und Warenkorbseiten über ihre Pfade (Links aus dem HTML der Startseite übernehmen).
