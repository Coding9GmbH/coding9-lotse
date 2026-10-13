<!-- Deutsch oder Englisch, beides ist willkommen. / German or English, both are welcome. -->

## Was / What
<!-- Was ändert dieser PR? / What does this PR change? -->

## Warum / Why
<!-- Welches Problem löst er? Verweis auf Issue, z. B. "Fixes #123". / Which problem does it solve? Link the issue, e.g. "Fixes #123". -->

## Tests
<!-- Wie wurde getestet (Plattform, KI-Anbieter, Sprache)? / How was it tested (platform, AI provider, language)? -->

## Checkliste / Checklist
- [ ] `npm run check` grün / green (Typecheck, ESLint, Tests)
- [ ] Tests ergänzt oder angepasst / tests added or updated
- [ ] Neue UI-Texte in `de` und `en` (`src/lib/i18n/messages/`) / new UI strings in `de` and `en`
- [ ] Sicherheitsgrenzen unverändert: KI nur lesend, Schreiben nur im Executor nach Freigabe / security boundaries unchanged: AI read-only, writes only in the executor after approval
- [ ] Doku angepasst, falls nötig (README, `docs/`, beide Sprachen) / docs updated if needed (README, `docs/`, both languages)
- [ ] Keine Zugangsdaten oder Kundendaten im Code, in Tests oder Screenshots / no credentials or customer data in code, tests or screenshots
