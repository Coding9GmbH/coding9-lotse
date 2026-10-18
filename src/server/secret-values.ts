// Which stored values count as secrets when Lotse scans or redacts text. A shop password like "shopware" or "admin123" is a
// stored secret too, but searching for it everywhere would hit every composer.json ("shopware/core") and blank out normal words
// for the AI and in logs. So only plausible secrets are searched as plain text; weak values are removed only where they stand as
// a credential ("password: …", "secret=…"). Pure functions, shared by settings.ts (redact) and the publish secret scan.

/** Words and names that are no secret even when someone stored them as one (lowercase; trailing digits/punctuation are ignored). */
const COMMON = new Set([
  'password', 'passwort', 'kennwort', 'secret', 'geheim', 'changeme', 'letmein', 'welcome', 'willkommen', 'admin', 'administrator',
  'root', 'test', 'testing', 'demo', 'default', 'example', 'sample', 'qwerty', 'qwertz', 'abcdef', 'abcdefgh', 'iloveyou', 'master',
  'shopware', 'shopify', 'magento', 'openmage', 'dockware', 'symfony', 'laravel', 'composer', 'storefront', 'administration',
  'github', 'gitlab', 'docker', 'mysql', 'mariadb', 'postgres', 'localhost', 'production', 'staging', 'development', 'sandbox',
]);

const classes = (v: string) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(v)).length;

/**
 * Whether a stored value is plausibly secret enough to be searched for as plain text: not a common word or package name (also
 * with digits or punctuation appended), at least 5 different characters, and long or mixed enough – 16+ characters, 12+ with two
 * character classes, or 8+ with three (e.g. "Xy7!pq3z").
 */
export function plausibleSecret(v: string | null | undefined): v is string {
  if (!v) return false;
  const len = [...v].length;
  if (len < 8 || new Set(v).size < 5) return false;
  const lower = v.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[\d\W_]+$/u, '')) || COMMON.has(lower.replace(/^[\d\W_]+/u, ''))) return false;
  const k = classes(v);
  return len >= 16 || (len >= 12 && k >= 2) || k >= 3;
}

const WORD = /[\p{L}\p{N}_]/u;
/**
 * Index of `value` in `text` where it stands as a token of its own (no letter, digit or underscore directly before or after it,
 * checked only on the sides where the value itself starts/ends with such a character), or -1. "shopware" in "shopware/core" is a
 * token; "Xy7pq3zA" inside "abcXy7pq3zA" is not.
 */
export function findToken(text: string, value: string): number {
  if (!value) return -1;
  const head = WORD.test(value[0]), tail = WORD.test(value[value.length - 1]);
  for (let i = text.indexOf(value); i !== -1; i = text.indexOf(value, i + 1)) {
    const before = i > 0 ? text[i - 1] : '', after = text[i + value.length] ?? '';
    if ((!head || !before || !WORD.test(before)) && (!tail || !after || !WORD.test(after))) return i;
  }
  return -1;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "password: x", "secret=x", "PASSWORD='x'", "token" => "x", "--password x": the value stands as a credential. */
const CREDENTIAL_KEY = String.raw`(?:pass(?:word|wort|wd|phrase)?|pwd|kennwort|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth)`;

/** Removes a weak stored value (not plausibleSecret) only where it stands as the value of a credential key, keeping the key. */
export function redactWeak(text: string, value: string, mask = '•••'): string {
  if (!value) return text;
  const re = new RegExp(String.raw`(\b[\w.-]*${CREDENTIAL_KEY}[\w.-]*["']?\s*(?:[:=]>?|=>|\s)\s*["']?)${escapeRe(value)}(?![\p{L}\p{N}_])`, 'giu');
  return text.replace(re, `$1${mask}`);
}
