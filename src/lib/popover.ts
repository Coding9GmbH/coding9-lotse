/** Linke Kante des Anmerkungsfensters, sodass es in der Spalte bleibt. */
export function popoverLeft(anchor: number, width: number, viewportWidth: number): number {
  const margin = 8;
  const max = Math.max(margin, viewportWidth - width - margin);
  return Math.min(Math.max(margin, anchor), max);
}
