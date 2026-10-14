// Namensraum "server": Texte, die der Server erzeugt und die der Mensch im Chat sieht (Rundenende, Abbruch, Neustart, Anmeldung).
// Texte nur für die KI (Prompts, Werkzeug-Ergebnisse) bleiben deutsch und gehören nicht hierher. Gespeichert wird in der Sprache des Augenblicks.

export const de = {
  cancelled: 'Abgebrochen',
  runCancelled: 'Abgebrochen.',
  onboardingTitle: 'Styleguide-Onboarding',
  unansweredRestart: 'Nicht beantwortet (Neustart)',
  restartRejected: 'Neustart, bitte erneut vorschlagen. Es wurde nichts geschrieben.',
  restartInterrupted: (applied: number, failed: number, counted: boolean) =>
    `Durch einen Neustart des Servers unterbrochen: ${applied} angewendet, ${failed} fehlgeschlagen (letzter gesicherter Zwischenstand)${counted ? '.' : '; ob weitere Elemente noch geschrieben wurden, ist unbekannt, bitte im Shop prüfen.'}`,
  restartInterruptedUndo: (n: number) =>
    `Durch einen Neustart des Servers unterbrochen, bevor ein Element abgeschlossen war: ${n} ${n === 1 ? 'Schreibschritt ist' : 'Schreibschritte sind'} gesichert und lassen sich rückgängig machen; ob weitere folgten, ist unbekannt, bitte im Shop prüfen.`,
  restartInterruptedUnknown: 'Durch einen Neustart unterbrochen, bevor ein Zwischenstand gesichert wurde: ob und was geschrieben wurde, ist unbekannt (siehe Audit „gestartet“). Bitte im Shop prüfen, nicht blind erneut anwenden.',
  wrongPlatform: (setPlatform: string, active: string) => `Das Änderungsset gehört zu ${setPlatform}, verbunden ist jetzt ${active}. Es wurde nichts geschrieben.`,
  codexNotLoggedIn: 'Codex ist nicht mit ChatGPT angemeldet (Einstellungen → KI verbinden).',
  codexBlockedTool: 'Codex wollte ein gesperrtes Werkzeug verwenden (Befehl/Datei/Websuche). Die Runde wurde abgebrochen.',
};

export const en: typeof de = {
  cancelled: 'Cancelled',
  runCancelled: 'Cancelled.',
  onboardingTitle: 'Style guide onboarding',
  unansweredRestart: 'Not answered (restart)',
  restartRejected: 'Server restarted, please propose again. Nothing was written.',
  restartInterrupted: (applied, failed, counted) =>
    `Interrupted by a server restart: ${applied} applied, ${failed} failed (last saved progress)${counted ? '.' : '; whether more items were written is unknown, please check the shop.'}`,
  restartInterruptedUndo: n =>
    `Interrupted by a server restart before an item was finished: ${n} write ${n === 1 ? 'step is' : 'steps are'} saved and can be undone; whether more followed is unknown, please check the shop.`,
  restartInterruptedUnknown: 'Interrupted by a restart before any progress was saved: whether and what was written is unknown (see audit entry “started”). Please check the shop, do not simply apply again.',
  wrongPlatform: (setPlatform, active) => `This change set belongs to ${setPlatform}, but ${active} is connected now. Nothing was written.`,
  codexNotLoggedIn: 'Codex is not signed in with ChatGPT (Settings → Connect AI).',
  codexBlockedTool: 'Codex tried to use a blocked tool (command/file/web search). The run was stopped.',
};
