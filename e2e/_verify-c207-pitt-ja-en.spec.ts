// SlopTank modification notice: added or changed by SlopTank on 2026-09-23.
/**
 * One-off user-visible verification for queue task t_260916_230754_669
 * (c207): every episode of The Pitt should offer in-sync English AND
 * Japanese subtitles. Modeled on e2e/_verify-c268-pitt-en-final.spec.ts
 * (env vars, login-via-localStorage approach, clickOsdControl, and the
 * MediaSourceId-in-PlaybackInfo-body pinning technique are reused
 * verbatim from that file).
 *
 * Deliberate difference from c268: this file does NOT reuse c268's
 * stopMyPlayback(), which stops every session matching NowPlayingItem.Id
 * regardless of who owns it. At verification time the item this spec
 * plays for the S01E01 scenario (8e8a6c016a072694fecb6128c02e812e) was
 * ALSO the item a real, live owner session was playing (see
 * deliverables/pitt-subs-20260923/final-verification.md, step 0); an
 * item-id-scoped stop would have killed that real session had it still
 * been active when this spec ran. Instead, stopOwnSession() below diffs
 * the session id list captured immediately before this spec starts
 * playback against the list after, and only ever stops a session id that
 * did not exist before -- i.e. one this browser context itself created.
 * This spec also polls /Sessions for up to 30 minutes before its first
 * test if any session is already watching anything, rather than assuming
 * the box is quiet.
 *
 * What this proves, against the live server with a real Chrome, for each
 * of S01E01 (720p), S01E10 (1080p) and S02E13 (2160p):
 *   1. time from the Play click to the first decoded video frame
 *      (video.currentTime > 0);
 *   2. selecting Japanese through the real OSD subtitle menu renders
 *      Japanese text during a dialogue window;
 *   3. selecting English through the same menu then renders English text
 *      at the same dialogue point.
 *
 * Env: JELLYFIN_TOKEN, JELLYFIN_SERVER_ID, JELLYFIN_USER_ID, E2E_BASE_URL,
 *      SHOT_DIR (screenshots).
 */
import * as fs from 'fs';
import { test, expect } from '@playwright/test';
import { clickOsdControl } from './fixtures';

const TOKEN = process.env.JELLYFIN_TOKEN as string;
const SERVER_ID = process.env.JELLYFIN_SERVER_ID as string;
const USER_ID = process.env.JELLYFIN_USER_ID as string;
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8096';
const SHOT_DIR = process.env.SHOT_DIR || 'test-results/c207-shots';

// Japanese: Hiragana + Katakana + CJK Unified Ideographs.
const JAPANESE_RE = /[぀-ヿ一-鿿]/;
const LATIN_LETTER_RE = /[A-Za-z]/;

// This dev server's Playwright-driven browser always registers under this
// fixed Client name (see e2e/_verify-c268-pitt-en-final.spec.ts's own note
// on the same fact). Its sessions have SupportsRemoteControl=false, so an
// admin Stop call cannot actually reach the (already-navigated-away) page
// to make it happen instantly; the session then only self-clears after
// Jellyfin's own device-activity timeout (observed: several minutes).
// Counting these as "someone is watching" would make the pre-flight check
// below block on the suite's own leftovers instead of on a real viewer.
const OWN_TEST_CLIENT = 'tools-admin-2026-07-22';

type EpisodeCase = {
    scenario: string;
    itemId: string;
    mediaSourceId: string;
    dialogueCandidates: number[];
};

const CASES: EpisodeCase[] = [
    {
        scenario: 's01e01-720p',
        itemId: '8e8a6c016a072694fecb6128c02e812e',
        mediaSourceId: '0748062aee37de86f1734384d8a0e376',
        dialogueCandidates: [120, 300, 480, 700, 900]
    },
    {
        scenario: 's01e10-1080p',
        itemId: '14467fd5d76918c96e63032e6de37e9e',
        mediaSourceId: '14467fd5d76918c96e63032e6de37e9e',
        dialogueCandidates: [120, 300, 480, 700, 900]
    },
    {
        scenario: 's02e13-2160p',
        itemId: '8cf81b51ce79081bb8d8de7e2a00923c',
        mediaSourceId: '8cf81b51ce79081bb8d8de7e2a00923c',
        dialogueCandidates: [120, 300, 480, 700, 900]
    }
];

const results: Record<string, unknown>[] = [];

// Playwright requires the first hook argument to be a destructuring
// pattern even when no fixture is used; a named parameter fails at
// runtime ("First argument must use the object destructuring pattern").
// eslint-disable-next-line no-empty-pattern -- see comment above
test.beforeAll(async ({}, testInfo) => {
    // Playwright's default hook timeout (30s) is far shorter than the up to
    // 30 minutes this hook may need to wait below; without raising it here,
    // Playwright kills the hook (and fails whichever test triggered this
    // worker) long before the wait completes.
    testInfo.setTimeout(31 * 60 * 1000);
    // Never assume the box is quiet: wait up to 30 minutes for any active
    // playback to stop before this spec starts its own. (Project rule:
    // never disturb playback; see CLAUDE.md "Never disturb playback".)
    const deadline = Date.now() + 30 * 60 * 1000;
    for (;;) {
        const sessions = await fetch(`${BASE}/Sessions?ApiKey=${TOKEN}`).then(r => r.json());
        const playing = (sessions as Array<{ NowPlayingItem?: unknown; Client?: string }>).filter(
            s => s.NowPlayingItem && s.Client !== OWN_TEST_CLIENT
        );
        console.log(`C207-PRECHECK playing_sessions=${playing.length}`);
        if (playing.length === 0) return;
        if (Date.now() >= deadline) {
            console.log('C207-PRECHECK-TIMEOUT proceeding after 30 minutes with playback still reported active');
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 60_000));
    }
});

async function seedAndGoto(page: import('@playwright/test').Page, route: string) {
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
    await page.goto(route);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#txtManualName')).toHaveCount(0);
}

async function pinVersion(page: import('@playwright/test').Page, msId: string) {
    // The web client POSTs PlaybackInfo with MediaSourceId in the request
    // BODY; a URL rewrite is silently overridden by it. Rewrite the body
    // (same technique as c268's pinVersion).
    await page.route(/\/Items\/.+\/PlaybackInfo/, async route => {
        const req = route.request();
        if (req.method() !== 'POST') return route.continue();
        let body: Record<string, unknown> = {};
        try {
            body = req.postDataJSON() as Record<string, unknown>;
        } catch (e) {
            console.log('C207-PIN-BODY-PARSE ' + String(e));
        }
        body.MediaSourceId = msId;
        await route.continue({ postData: JSON.stringify(body) });
    });
}

async function getSessionIds(): Promise<string[]> {
    const sessions = await fetch(`${BASE}/Sessions?ApiKey=${TOKEN}`).then(r => r.json());
    return (sessions as Array<{ Id: string }>).map(s => s.Id);
}

/** Stop only a session id that did not exist in priorIds -- i.e. one this
 * browser context created itself, never a pre-existing (possibly real)
 * viewer's session that happens to share the same item id. */
async function stopOwnSession(itemId: string, priorIds: string[]) {
    const sessions = await fetch(`${BASE}/Sessions?ApiKey=${TOKEN}`).then(r => r.json());
    const mine = (sessions as Array<{ Id: string; NowPlayingItem?: { Id?: string } }>).filter(
        s => s.NowPlayingItem && s.NowPlayingItem.Id === itemId && !priorIds.includes(s.Id)
    );
    for (const s of mine) {
        await fetch(`${BASE}/Sessions/${s.Id}/Playing/Stop`, { method: 'POST' }).catch(e =>
            console.log('C207-STOP ' + String(e)));
    }
}

async function beginPlaybackTimed(
    page: import('@playwright/test').Page,
    itemId: string
): Promise<{ video: import('@playwright/test').Locator; timeToFirstFrameMs: number }> {
    const details = `${BASE}/web/#/details?id=${itemId}&serverId=${SERVER_ID}`;
    if (page.url().indexOf('/web/') !== -1) {
        await page.goto('about:blank').catch(e => console.log('C207-BLANK ' + String(e)));
    }
    try {
        await page.goto(details, { timeout: 60_000 });
    } catch (e) {
        console.log('C207-GOTO-SLOW ' + String(e));
        await page.goto('about:blank').catch(e2 => console.log('C207-BLANK-RETRY ' + String(e2)));
        await page.goto(details, { timeout: 90_000 });
    }
    const btnPlay = page.locator('.mainDetailButtons .btnPlay:visible');
    try {
        await btnPlay.waitFor({ state: 'visible', timeout: 45_000 });
    } catch (e) {
        console.log('C207-DETAILS-SLOW ' + String(e));
        await page.reload();
        await btnPlay.waitFor({ state: 'visible', timeout: 90_000 });
    }
    const t0 = Date.now();
    await btnPlay.click({ timeout: 45_000 });
    await page.waitForURL(/\/video\?id=/, { timeout: 60_000 });
    const video = page.locator('video').first();
    await video.waitFor({ state: 'visible', timeout: 120_000 });
    await video.evaluate((v: HTMLVideoElement) => {
        v.muted = true;
        v.play().catch(e => console.log('C207-AUTOPLAY ' + String(e)));
    });
    await expect
        .poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 60_000 })
        .toBeGreaterThan(0);
    const timeToFirstFrameMs = Date.now() - t0;
    return { video, timeToFirstFrameMs };
}

type SubtitleFetch = { url: string; text: string; capturedAt: number };

/**
 * Some subtitle formats (ASS/SSA) are rendered by the player onto a
 * <canvas> via SubtitlesOctopus/libass-wasm (see
 * src/plugins/htmlVideoPlayer/plugin.js renderSsaAss()), never as DOM text
 * -- readRendered()'s native-track and .videoSubtitlesInner reads both
 * come back empty for such a track even while it is visibly rendering
 * (confirmed by screenshot during this spec's own diagnosis on S01E10
 * 1080p's embedded ASS English track). Capturing the actual subtitle
 * document the player fetched for rendering gives a technology-agnostic,
 * definitive signal of which language's content was loaded, independent
 * of how (or whether) it can be read back out of the DOM.
 */
function attachSubtitleCapture(page: import('@playwright/test').Page): { fetches: SubtitleFetch[] } {
    const state = { fetches: [] as SubtitleFetch[] };
    page.on('response', response => {
        const url = response.url();
        if (!/\/Subtitles\//.test(url)) return;
        response.text()
            .then(text => state.fetches.push({ url, text, capturedAt: Date.now() }))
            .catch(e => console.log('C207-SUB-FETCH-READ ' + String(e)));
    });
    return state;
}

async function waitForSubtitleTextAfter(
    state: { fetches: SubtitleFetch[] },
    sinceMs: number,
    timeoutMs: number
): Promise<{ text: string; url: string } | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const matches = state.fetches.filter(f => f.capturedAt >= sinceMs);
        if (matches.length) {
            const last = matches[matches.length - 1];
            return { text: last.text, url: last.url };
        }
        if (Date.now() >= deadline) return null;
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

async function selectSubtitleTrack(page: import('@playwright/test').Page, matchText: string) {
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    const sheet = page.locator('.actionSheet:visible');
    await sheet.locator('button').first().waitFor({ state: 'visible', timeout: 15_000 });
    const allOptions = await sheet.locator('button').allTextContents();
    console.log(`C207-MENU-OPTIONS ${JSON.stringify(allOptions)} matching=${JSON.stringify(matchText)}`);
    const option = sheet.locator(`button:has-text("${matchText}")`).first();
    const matchedText = await option.textContent();
    console.log(`C207-MENU-MATCHED ${JSON.stringify(matchedText)}`);
    await option.waitFor({ state: 'visible', timeout: 10_000 });
    await option.click();
    await page.waitForTimeout(1500);
}

/**
 * Best-effort DOM read of rendered subtitle text. Covers two of this
 * player's three subtitle rendering paths (native <track> cues, and the
 * plain-text ".videoSubtitlesInner" overlay used for the "custom" path);
 * it structurally cannot see the third (ASS/SSA tracks painted onto a
 * <canvas> by SubtitlesOctopus/libass-wasm -- see attachSubtitleCapture()
 * above for how that path is verified instead). An empty result here is
 * therefore not on its own proof of a rendering gap; callers combine it
 * with the network-delivered subtitle document.
 */
async function readRendered(video: import('@playwright/test').Locator, page: import('@playwright/test').Page) {
    // Read every 'showing' track, not just the first: switching from an
    // external-SRT track to an embedded one was observed to leave the
    // PREVIOUS TextTrack object also at mode 'showing', so picking only
    // the first match can read the wrong (stale) track.
    const native = await video.evaluate((el: HTMLVideoElement) => {
        const showing = Array.from(el.textTracks).filter(t => t.mode === 'showing');
        const texts: string[] = [];
        for (const track of showing) {
            if (!track.activeCues || track.activeCues.length === 0) continue;
            texts.push(Array.from(track.activeCues).map(c => (c as VTTCue).text).join(' | '));
        }
        return texts.join(' | ');
    });
    let custom = '';
    const customLocator = page.locator('.videoSubtitlesInner');
    if (await customLocator.count()) {
        custom = ((await customLocator.textContent({ timeout: 1500 }).catch(e => {
            console.log('C207-CUE-READ ' + String(e));
            return '';
        })) ?? '').trim();
    }
    return { native, custom };
}

async function sampleAt(
    video: import('@playwright/test').Locator,
    page: import('@playwright/test').Page,
    target: number,
    windowMs: number
): Promise<{ text: string; shot: Buffer }> {
    // Pause before seeking so a previous poll loop's drift (playback keeps
    // advancing while it runs) never turns this into a large backward seek
    // from wherever the video happened to end up. Then confirm the seek
    // actually landed before trusting reads: a currentTime write issued
    // while the player is mid-transition (e.g. right after a subtitle
    // track switch) can be silently discarded -- the same race
    // e2e/fixtures.ts's parkOnCue() guards against.
    await video.evaluate((el: HTMLVideoElement) => el.pause());
    await video.evaluate((el: HTMLVideoElement, t) => {
        el.currentTime = t;
    }, target);
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime),
            { timeout: 15_000, message: `seek to t=${target} never landed` })
        .toBeGreaterThanOrEqual(target - 0.5);
    await video.evaluate((el: HTMLVideoElement) => {
        el.play().catch(e => console.log('C207-SEEKPLAY ' + String(e)));
    });

    // Poll for rendered text, exiting as soon as it is found so playback
    // never drifts further than necessary past a short cue's end -- the
    // next call (typically the same anchor under a different subtitle
    // track) reseeks from close to where this one stopped.
    const deadline = Date.now() + windowMs;
    let bestText = '';
    let shot: Buffer | null = null;
    while (Date.now() < deadline) {
        await page.waitForTimeout(400);
        const { native, custom } = await readRendered(video, page);
        const text = (custom || native || '').trim();
        if (text) {
            bestText = text;
            shot = await page.screenshot();
            break;
        }
    }
    if (!shot) shot = await page.screenshot();
    return { text: bestText, shot };
}

/** Try each candidate dialogue timestamp until one shows rendered text. */
async function findDialogueAndCapture(
    video: import('@playwright/test').Locator,
    page: import('@playwright/test').Page,
    candidates: number[],
    windowMs: number
): Promise<{ text: string; t: number; shot: Buffer }> {
    let last: { text: string; t: number; shot: Buffer } | null = null;
    for (const t of candidates) {
        const { text, shot } = await sampleAt(video, page, t, windowMs);
        last = { text, t, shot };
        if (text) return last;
    }
    return last as { text: string; t: number; shot: Buffer };
}

for (const c of CASES) {
    test(`${c.scenario}: Japanese and English subtitles render at a dialogue point`, async ({ page }) => {
        test.setTimeout(420_000);
        // Capture BEFORE any navigation: the web client registers its
        // Jellyfin session as soon as it connects, not when playback
        // starts, so capturing this after seedAndGoto/pinVersion would
        // already include this test's own session and stopOwnSession()
        // would then wrongly treat it as pre-existing and never stop it.
        const priorSessionIds = await getSessionIds();
        const subCapture = attachSubtitleCapture(page);
        await seedAndGoto(page, `${BASE}/web/`);
        await pinVersion(page, c.mediaSourceId);

        const { video, timeToFirstFrameMs } = await beginPlaybackTimed(page, c.itemId);
        console.log(`C207-TTFF ${c.scenario} timeToFirstFrameMs=${timeToFirstFrameMs}`);

        const beforeJaSelect = Date.now();
        await selectSubtitleTrack(page, 'Japanese');
        const ja = await findDialogueAndCapture(video, page, c.dialogueCandidates, 15_000);
        const jaShotPath = `${SHOT_DIR}/${c.scenario}-ja.png`;
        fs.writeFileSync(jaShotPath, ja.shot);
        const jaDoc = await waitForSubtitleTextAfter(subCapture, beforeJaSelect, 15_000);
        console.log(`C207-JA ${c.scenario} t=${ja.t} domText=${JSON.stringify(ja.text)} `
            + `deliveredDoc=${jaDoc ? jaDoc.url : null}`);
        const jaEvidence = ja.text || jaDoc?.text || '';
        expect(jaEvidence, `${c.scenario}: expected Japanese text to render (DOM) or be `
            + `delivered (network) at t=${ja.t}`).toMatch(JAPANESE_RE);

        const beforeEnSelect = Date.now();
        await selectSubtitleTrack(page, 'English');
        const en = await sampleAt(video, page, ja.t, 15_000);
        const enShotPath = `${SHOT_DIR}/${c.scenario}-en.png`;
        fs.writeFileSync(enShotPath, en.shot);
        const enDoc = await waitForSubtitleTextAfter(subCapture, beforeEnSelect, 15_000);
        console.log(`C207-EN ${c.scenario} t=${ja.t} domText=${JSON.stringify(en.text)} `
            + `deliveredDoc=${enDoc ? enDoc.url : null}`);
        const enEvidence = en.text || enDoc?.text || '';
        expect(enEvidence, `${c.scenario}: expected English text to render (DOM) or be `
            + `delivered (network) at t=${ja.t}`).toMatch(LATIN_LETTER_RE);
        expect(enEvidence, `${c.scenario}: English render should not itself be Japanese`).not.toMatch(JAPANESE_RE);

        await stopOwnSession(c.itemId, priorSessionIds);

        results.push({
            scenario: c.scenario,
            itemId: c.itemId,
            mediaSourceId: c.mediaSourceId,
            timeToFirstFrameMs,
            dialogueT: ja.t,
            jaText: ja.text,
            jaDeliveredDocUrl: jaDoc?.url ?? null,
            enText: en.text,
            enDeliveredDocUrl: enDoc?.url ?? null,
            jaScreenshot: jaShotPath,
            enScreenshot: enShotPath
        });
        console.log(`C207-RESULT ${JSON.stringify(results[results.length - 1])}`);
    });
}

test.afterAll(async () => {
    const summaryPath = `${SHOT_DIR}/c207-results.json`;
    try {
        fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
    } catch (e) {
        console.log('C207-SUMMARY-WRITE-FAILED ' + String(e));
    }
});
