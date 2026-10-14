// Side-effect import: include before all modules of the test. Creates an empty data directory so the
// test doesn't depend on a local data/ (style guide, settings, database).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-test-'));
