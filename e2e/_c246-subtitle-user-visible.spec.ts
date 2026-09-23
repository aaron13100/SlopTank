// SlopTank modification notice: added or changed by SlopTank on 2026-09-20, 2026-09-23.
/**
 * One-off user-visible verification for queue task t_260920_054052_823 (c246).
 *
 * The task's own closing gate requires a REAL browser check of the live site:
 * a server-internal check or a curl cannot prove what the client renders,
 * because MediaStreams is a cache and the phantom tracks the owner reported
 * were client-visible entries whose files no longer existed.
 *
 * Authenticates by seeding the web client's own credential store with the
 * admin token from tools/jellyfin.env, so no password is typed into any form.
 *
 * Deliberately NOT named `_verify-t<taskid>-*`: the chromium project ignores
 * that pattern, and this check has to actually run.
 *
 * Env: JELLYFIN_TOKEN, JELLYFIN_SERVER_ID, JELLYFIN_USER_ID, VERIFY_ITEM_ID.
 */
import { test, expect } from '@playwright/test';

const TOKEN = process.env.JELLYFIN_TOKEN as string;
const SERVER_ID = process.env.JELLYFIN_SERVER_ID as string;
const USER_ID = process.env.JELLYFIN_USER_ID as string;
const ITEM_ID = process.env.VERIFY_ITEM_ID as string;
const BASE = process.env.E2E_BASE_URL || 'http://localhost:8096';

test('the client sees only subtitle tracks it can actually fetch', async ({ page }) => {
    await page.addInitScript(
        ({ token, serverId, userId, base }) => {
            localStorage.setItem('jellyfin_credentials', JSON.stringify({
                Servers: [ {
                    ManualAddress: base,
                    Id: serverId,
                    AccessToken: token,
                    UserId: userId,
                    DateLastAccessed: Date.now(),
                    LastConnectionMode: 1
                } ]
            }));
        },
        { token: TOKEN, serverId: SERVER_ID, userId: USER_ID, base: BASE }
    );

    await page.goto(`/web/#/details?id=${ITEM_ID}&serverId=${SERVER_ID}`);
    await page.waitForLoadState('domcontentloaded');

    // Prove the session is authenticated: an unauthenticated client is parked
    // on the login form and would render no item at all, which would make an
    // "and no phantom track was found" result meaningless.
    await expect(page.locator('#txtManualName')).toHaveCount(0);

    // Ask the SERVER what the CLIENT is told, from inside the page's own
    // authenticated context, then fetch every advertised external track the
    // way the player does.
    const report = await page.evaluate(async ({ itemId, userId, token }) => {
        // Legacy X-Emby-Token auth is disabled on this server; the ApiKey
        // query parameter is the supported form.
        const detail = await fetch(
            `/Items/${itemId}?userId=${userId}&Fields=MediaSources,MediaStreams&ApiKey=${token}`
        ).then(r => r.json());

        const out: { lang: string; index: number; codec: string; status: number; bytes: number }[] = [];
        for (const source of detail.MediaSources || []) {
            for (const stream of source.MediaStreams || []) {
                if (stream.Type !== 'Subtitle' || !stream.IsExternal) continue;
                const response = await fetch(
                    `/Videos/${itemId}/${source.Id}/Subtitles/${stream.Index}/0/Stream.vtt?ApiKey=${token}`
                );
                const body = response.ok ? await response.text() : '';
                out.push({
                    lang: stream.Language,
                    index: stream.Index,
                    codec: stream.Codec,
                    status: response.status,
                    bytes: body.length
                });
            }
        }
        return { name: detail.Name, series: detail.SeriesName, tracks: out };
    }, { itemId: ITEM_ID, userId: USER_ID, token: TOKEN });

    console.log('ITEM:', report.series, '/', report.name);
    console.log('ADVERTISED EXTERNAL SUBTITLE TRACKS:', JSON.stringify(report.tracks, null, 1));

    // POSITIVE control: the item must still advertise real tracks, otherwise
    // "no broken track" would be trivially true on an empty list.
    expect(report.tracks.length).toBeGreaterThan(0);

    // The actual assertion: every track the client is offered is fetchable.
    const broken = report.tracks.filter(t => t.status !== 200 || t.bytes < 64);
    expect(broken, `client-visible tracks that cannot be fetched: ${JSON.stringify(broken)}`).toEqual([]);

    await page.screenshot({
        path: '../deliverables/t_260920_054052_823/user-visible-subtitle-check.png',
        fullPage: false
    });
});
