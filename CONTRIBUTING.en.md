[Deutsch](CONTRIBUTING.md) · **English**

# Contributing

Thanks for your interest in Lotse! Bug reports, ideas and pull requests are welcome.

## Bugs and ideas
- Report bugs and wishes as an [issue](../../issues) (the forms ask for everything needed) – with platform (Shopware, Shopify, Magento, OpenMage), Lotse version and, if possible, steps to reproduce.
- **Do not report security vulnerabilities publicly**; follow [SECURITY.en.md](SECURITY.en.md) instead.
- Please do not post credentials, customer data or shop URLs with sensitive content in issues or screenshots.

## Development
```bash
npm install          # Node ≥ 22.13
make dev             # http://localhost:3333
make demo            # optional: add a demo shop (dockware)
npm run check        # typecheck, ESLint, tests – before every pull request
```

## Translations
The UI is available in German and English.
- UI strings live in `src/lib/i18n/messages/<namespace>.ts`. `de` defines the shape, `en` must have exactly the same keys (`en: typeof de`); this is enforced by TypeScript and `tests/lib/i18n.test.ts`. Placeholders and plurals are functions, e.g. `count: (n: number) => …`.
- Always add new UI strings in both languages; no hard-coded text in components.
- New language: add it to `LOCALES` (and `LOCALE_NAMES`, `INTL_LOCALE`) in `src/lib/i18n/locales.ts` and add a dictionary to every namespace.
- The AI's reply language is set in `src/server/prompt.ts` (`REPLY_LANGUAGE`).

## Pull requests
- Small, focused changes; one topic per PR.
- Add or update tests; `npm run check` must be green.
- Record every user-visible change under "Unveröffentlicht" (unreleased) in [`CHANGELOG.md`](CHANGELOG.md).
- The security boundaries stay in place: the AI only reads (`ReadOnly…` clients), and writing happens exclusively in the executor after approval. Changes that weaken this need a thorough justification.
- By contributing, you agree that your contribution is published under the [MIT license](LICENSE).
