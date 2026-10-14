/** Left edge of the annotation popover, so that it stays within the column. */
export function popoverLeft(anchor: number, width: number, viewportWidth: number): number {
  const margin = 8;
  const max = Math.max(margin, viewportWidth - width - margin);
  return Math.min(Math.max(margin, anchor), max);
}
