// Side-Effect-Import: vor allen Modulen des Tests einbinden. Legt ein leeres Datenverzeichnis an, damit der
// Test nicht von einer lokalen data/ (Styleguide, Einstellungen, Datenbank) abhängt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-test-'));
