// Release check for PRs. Ordinary PRs leave package.json's version untouched and always pass.
// When the version is bumped, package-lock.json must match and CHANGELOG.md needs a section
// "## [x.y.z] – YYYY-MM-DD" with at least one category plus the compare link at the bottom.
// Usage: node .github/scripts/check-release.mjs <base-ref>   (e.g. origin/main; works locally too)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const base = process.argv[2] || 'origin/main';
const show = (file) => execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' });
const parse = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v); if (!m) throw new Error(`Keine gültige Version: ${v}`); return m.slice(1).map(Number); };
const greater = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

const head = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const prev = JSON.parse(show('package.json')).version;

// No release: nothing to check (CHANGELOG and version are only written when a new version is tagged).
if (head === prev) {
  console.log(`OK: Version ${head} unverändert, kein Release`);
  process.exit(0);
}

const errors = [];
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
if (lock.version !== head || lock.packages?.['']?.version !== head) errors.push(`package-lock.json hat nicht Version ${head} – npm version … aktualisiert beide Dateien`);
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const hasEntries = (body) => /^### .+\n+- \S/m.test(body);

if (!greater(parse(head), parse(prev))) errors.push(`Version in package.json (${head}) muss höher sein als auf ${base} (${prev}) – z. B. npm version patch --no-git-tag-version`);
const esc = head.replace(/\./g, '\\.');
const section = new RegExp(`^## \\[${esc}\\] – \\d{4}-\\d{2}-\\d{2}\\n([\\s\\S]*?)(?=^## \\[|^\\[)`, 'm').exec(changelog);
if (!section) errors.push(`CHANGELOG.md braucht einen Abschnitt „## [${head}] – JJJJ-MM-TT“`);
else if (!hasEntries(section[1])) errors.push(`Abschnitt ${head} in CHANGELOG.md braucht mindestens eine Rubrik (### …) mit Eintrag`);
if (!new RegExp(`^\\[${esc}\\]: https://`, 'm').test(changelog)) errors.push(`CHANGELOG.md braucht unten den Vergleichslink „[${head}]: https://…“`);

if (errors.length) { console.error('Versions-/CHANGELOG-Prüfung fehlgeschlagen:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log(`OK: ${prev} → ${head}, CHANGELOG-Abschnitt vorhanden`);
