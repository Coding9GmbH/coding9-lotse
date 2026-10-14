import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Accessibility (smoke test): only critical violations fail the test, the rest goes into the report
for (const path of ['/', '/settings', '/settings/ki-zugriff', '/settings/integrationen', '/settings/protokolle', '/wissen']) {
  test(`axe: no critical violations on ${path}`, async ({ page }, info) => {
    await page.goto(path);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    await info.attach('axe-violations.json', { body: JSON.stringify(violations, null, 2), contentType: 'application/json' });
    const critical = violations.filter(v => v.impact === 'critical');
    expect(critical.map(v => `${v.id}: ${v.help} (${v.nodes.map(n => n.target.join(' ')).join(', ')})`)).toEqual([]);
  });
}
