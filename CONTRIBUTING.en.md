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
- Every PR bumps the version and gets its own section in [`CHANGELOG.md`](CHANGELOG.md), see [Versions & changelog](#versions--changelog). CI checks this (`release-check`).
- The security boundaries stay in place: the AI only reads (`ReadOnly…` clients), and writing happens exclusively in the executor after approval. Changes that weaken this need a thorough justification.
- By contributing, you agree that your contribution is published under the [MIT license](LICENSE).

## Versions & changelog
Every change (every PR) gets a new version, so it is always clear what a release contains.
1. **Bump the version** following [SemVer](https://semver.org/): `npm version patch --no-git-tag-version` for fixes, `minor` for new features or behaviour changes, `major` for breaking changes (e.g. configuration that must be changed by hand). This updates `package.json` and `package-lock.json`.
2. **Write the changelog**: add a section `## [x.y.z] – YYYY-MM-DD` at the top of [`CHANGELOG.md`](CHANGELOG.md) (the changelog is kept in German), with the matching headings (`### Sicherheit`, `### Hinzugefügt`, `### Geändert`, `### Behoben`, `### Entfernt`) and one sentence per change from the user's point of view – what is different and what they may need to do (new environment variable, migration, changed behaviour). Add the compare link `[x.y.z]: https://github.com/Coding9GmbH/coding9-lotse/compare/v<previous>...v<x.y.z>` at the bottom.
3. Check: `node .github/scripts/check-release.mjs origin/main`.

If `main` has moved on and already used the same version, take the next number after merging. Dependency-only updates from Dependabot are exempt; they go into the changelog with the next version.
