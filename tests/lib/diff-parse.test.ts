import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../../src/lib/diff-parse';

// "Änderungen" tab: per file with status, +/− counts and old/new line numbers; git's meta lines are fields, not text.
const PATCH = `diff --git a/src/header.html.twig b/src/header.html.twig
index 7736514..a1b2c3d 100644
--- a/src/header.html.twig
+++ b/src/header.html.twig
@@ -3,4 +3,4 @@ {% block header %}
 <header>
-  <p>Alt</p>
+  <p>Neu</p>
 </header>
\\ No newline at end of file
diff --git a/src/new.scss b/src/new.scss
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.scss
@@ -0,0 +1,2 @@
+.a {}
+.b {}
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 2222222..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-weg
diff --git a/a.txt b/b.txt
similarity index 90%
rename from a.txt
rename to b.txt
diff --git a/logo.png b/logo.png
index 3333333..4444444 100644
Binary files a/logo.png and b/logo.png differ
`;

test('parseDiff: files, status, counts, line numbers; meta lines are not content', () => {
  const files = parseDiff(PATCH);
  assert.deepEqual(files.map(f => [f.path, f.status, f.added, f.removed]), [
    ['src/header.html.twig', 'modified', 1, 1], ['src/new.scss', 'added', 2, 0], ['old.txt', 'deleted', 0, 1], ['b.txt', 'renamed', 0, 0], ['logo.png', 'modified', 0, 0],
  ]);
  const [h] = files[0].hunks;
  assert.equal(h.header, '@@ -3,4 +3,4 @@ {% block header %}');
  assert.deepEqual(h.lines.map(l => [l.kind, l.old, l.new, l.text]), [
    ['ctx', 3, 3, '<header>'], ['del', 4, null, '  <p>Alt</p>'], ['add', null, 4, '  <p>Neu</p>'], ['ctx', 5, 5, '</header>'], ['note', null, null, 'No newline at end of file'],
  ]);
  assert.equal(files[3].oldPath, 'a.txt');
  assert.equal(files[4].binary, true);
  assert.ok(!files.flatMap(f => f.hunks.flatMap(x => x.lines)).some(l => /^(diff --git|index |--- |\+\+\+ )/.test(l.text)));
});
