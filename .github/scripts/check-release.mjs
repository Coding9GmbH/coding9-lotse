// PR-Prüfung: Jede Änderung braucht eine höhere Version in package.json und einen passenden Abschnitt in CHANGELOG.md.
// Aufruf: node .github/scripts/check-release.mjs <base-ref>   (z. B. origin/main; lokal genauso nutzbar)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const base = process.argv[2] || 'origin/main';
const show = (file) => execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' });
const parse = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v); if (!m) throw new Error(`Keine gültige Version: ${v}`); return m.slice(1).map(Number); };
const greater = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

const head = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const prev = JSON.parse(show('package.json')).version;
const errors = [];
if (!greater(parse(head), parse(prev))) errors.push(`Version in package.json (${head}) muss höher sein als auf ${base} (${prev}) – z. B. npm version patch --no-git-tag-version`);
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
if (lock.version !== head || lock.packages?.['']?.version !== head) errors.push(`package-lock.json hat nicht Version ${head} – npm version … aktualisiert beide Dateien`);
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const esc = head.replace(/\./g, '\\.');
const section = new RegExp(`^## \\[${esc}\\] – \\d{4}-\\d{2}-\\d{2}\\n([\\s\\S]*?)(?=^## \\[|^\\[)`, 'm').exec(changelog);
if (!section) errors.push(`CHANGELOG.md braucht einen Abschnitt „## [${head}] – JJJJ-MM-TT“`);
else if (!/^### .+\n+- \S/m.test(section[1])) errors.push(`Abschnitt ${head} in CHANGELOG.md braucht mindestens eine Rubrik (### …) mit Eintrag`);
if (!new RegExp(`^\\[${esc}\\]: https://`, 'm').test(changelog)) errors.push(`CHANGELOG.md braucht unten den Vergleichslink „[${head}]: https://…“`);

if (errors.length) { console.error('Versions-/CHANGELOG-Prüfung fehlgeschlagen:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log(`OK: ${prev} → ${head}, CHANGELOG-Abschnitt vorhanden`);
