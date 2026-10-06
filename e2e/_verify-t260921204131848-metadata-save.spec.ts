import { expect } from '@playwright/test';
import { login, onScreenState, test } from './fixtures';

/**
 * One-off live verification for t_260921_204131_848 (c266): the series
 * metadata editor must never spin forever on a save. The live server may
 * accept the save (toast "Item saved." and the editor closes) or refuse it
 * with a prompt ProblemDetails 409 (the spinner hides and the surfaced alert
 * carries the server's code and detail). Either terminal outcome satisfies
 * the never-ending-spinner contract; this spec records which one occurred
 * and the verbatim surfaced text, and fails only when no outcome arrives or
 * the loading layer is still active when one does.
 *
 * Run (the standing chromium project testIgnores _verify-t files, so point a
 * scratch config at this file that overrides projects with testIgnore: [],
 * or run from a config copy next to playwright.config.ts so its relative
 * paths keep resolving):
 *   npx playwright test e2e/_verify-t260921204131848-metadata-save.spec.ts \
 *     --config=<scratch-config> --project=chromium
 * with ../.env.e2e.local sourced and node 24 via nvm.
 */

const SERIES_ID = '2cb80377bb85ce15a9abd34def50983b';
const SAVE_OUTCOME_TIMEOUT_MS = 15_000;

test('The Pitt series metadata save reaches a terminal outcome (never-ending spinner contract)', async ({ page, config }, testInfo) => {
    test.setTimeout(120_000);
    await login(page, config.username, config.password);
    await page.goto(`/web/#/details?id=${SERIES_ID}&serverId=${config.serverId}`, { waitUntil: 'domcontentloaded' });

    // The series detail page rendered for a human.
    await expect(page.locator('h1').filter({ hasText: 'The Pitt' }).first()).toBeVisible({ timeout: 30_000 });

    // Open the item menu with real input; the button must be on screen.
    const moreState = await onScreenState(page, '.btnMoreCommands');
    expect(moreState.found, 'more button present on the detail page').toBe(true);
    expect(moreState.reachable, 'more button reachable: ' + JSON.stringify(moreState)).toBe(true);
    await page.locator('.btnMoreCommands:visible').first().click();

    const editCommand = page.locator('.actionSheetMenuItem', { hasText: 'Edit metadata' }).first();
    await expect(editCommand).toBeVisible({ timeout: 10_000 });
    await editCommand.click();

    // The editor dialog mounted with the custom rating control.
    const form = page.locator('.editItemMetadataForm').first();
    await expect(form).toBeVisible({ timeout: 30_000 });
    const ratingSelect = form.locator('#selectCustomRating');
    await expect(ratingSelect).toBeVisible({ timeout: 15_000 });
    await ratingSelect.scrollIntoViewIfNeeded();
    const ratingState = await onScreenState(page, '#selectCustomRating');
    expect(ratingState.found, 'custom rating control present').toBe(true);
    expect(ratingState.reachable, 'custom rating reachable: ' + JSON.stringify(ratingState)).toBe(true);

    // Options load asynchronously from the server's rating list.
    await expect.poll(async () => ratingSelect.locator('option').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const ratingValues = await ratingSelect.locator('option').evaluateAll(
        (options: Element[]) => options.map((o) => (o as HTMLSelectElement).value ?? (o as HTMLSelectElement).textContent ?? ''));
    testInfo.attach('custom-rating-options', { body: JSON.stringify(ratingValues), contentType: 'application/json' });
    expect(ratingValues, 'rating list offers R').toContain('R');
    await ratingSelect.selectOption('R');

    const saveButton = form.locator('.btnSave').first();
    await saveButton.scrollIntoViewIfNeeded();
    const saveState = await onScreenState(page, '.editItemMetadataForm .btnSave');
    expect(saveState.found, 'save button present').toBe(true);
    expect(saveState.reachable, 'save button reachable: ' + JSON.stringify(saveState)).toBe(true);

    const spinner = page.locator('.docspinner.mdlSpinnerActive');
    await saveButton.click();

    // Wait for a terminal outcome: the surfaced refusal alert, the success
    // toast, or the editor closing. No outcome inside the window is the
    // never-ending-spinner defect this task exists for.
    const alertText = page.locator('.dialog .formDialogContent .text').first();
    const savedToast = page.locator('.toastVisible', { hasText: 'Item saved.' }).first();
    await expect
        .poll(
            async () => (await alertText.isVisible() && (await alertText.textContent()) !== '')
                || await savedToast.isVisible()
                || !(await form.isVisible()),
            { timeout: SAVE_OUTCOME_TIMEOUT_MS, intervals: [250, 500, 1_000] })
        .toBe(true);

    // The loading layer must be down by the time any terminal outcome shows.
    await expect(spinner).toHaveCount(0, { timeout: 10_000 });

    const surfaced = (await alertText.textContent()) ?? '';
    const toastShown = await savedToast.isVisible().catch(() => false);
    const editorClosed = !(await form.isVisible().catch(() => false));
    const verdict = {
        outcome: surfaced ? 'surfaced-error' : (toastShown ? 'saved-toast' : 'editor-closed'),
        surfacedError: surfaced || null,
        toastShown,
        editorClosed
    };
    testInfo.attach('save-outcome', { body: JSON.stringify(verdict, null, 2), contentType: 'application/json' });
    console.log('[c266-live] save outcome: ' + JSON.stringify(verdict));

    if (surfaced) {
        await page.screenshot({ path: testInfo.outputPath('c266-editor-surfaced-error.png'), fullPage: true });
    }

    // Dismiss the alert so the browser session ends clean.
    if (surfaced) {
        const gotIt = page.getByRole('button', { name: 'Got It' }).first();
        if (await gotIt.isVisible().catch(() => false)) {
            await gotIt.click();
        }
    }
});
