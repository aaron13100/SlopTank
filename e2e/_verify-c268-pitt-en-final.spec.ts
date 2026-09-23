/**
 * One-off user-visible verification for queue task t_260921_214748_767 (c268):
 * mistimed English sidecar on The Pitt S01E08 (item ef2d373c566ee0f5f8d4e8526118af21),
 * final state. Complements the earlier defect-run logs (run3/run7) with the
 * piece they could not measure: what the AUTO-selected subtitle track is on an
 * untouched playback session, per version, and whether it renders in sync.
 *
 * What this proves, against the live server with a real Chrome:
 *   1. For each pinned version of E08 (720p MIKE / 1080p HEVC), and for the
 *      retimed E04/E06 sidecars and E05's internal track: which subtitle track
 *      a fresh, untouched browser session auto-selects (read server-side from
 *      the session's PlayState.SubtitleStreamIndex, not from DOM state) and
 *      which track the OSD menu reports as selected (check icon visibility).
 *   2. What actually renders while PLAYING through fixed dialogue windows
 *      (the custom renderer's text is polled with video.currentTime; each
 *      window is compared offline against the on-disk document's cues).
 *   3. Version pinning happens at the PlaybackInfo POST BODY level: the web
 *      client sends MediaSourceId in the body, so a URL-level route rewrite
 *      (used by the earlier runs) never takes effect.
 *
 * For the 1080p version, whose source has no server DefaultSubtitleStreamIndex,
 * a second in-context replay after one user selection demonstrates the
 * returning-user auto-selection (remembered English).
 *
 * Env: JELLYFIN_TOKEN, JELLYFIN_SERVER_ID, JELLYFIN_USER_ID, E2E_BASE_URL,
 *      SHOT_DIR (screenshots), PIN_MS_ID_1080P (E08 1080p media source id).
 */
import { test, expect } from '@playwright/test';
import { clickOsdControl } from './fixtures';

const TOKEN = process.env.JELLYFIN_TOKEN as string;
const SERVER_ID = process.env.JELLYFIN_SERVER_ID as string;
const USER_ID = process.env.JELLYFIN_USER_ID as string;
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8096';
const SHOT_DIR = process.env.SHOT_DIR || test.info().outputDir;

const E08_ITEM = 'ef2d373c566ee0f5f8d4e8526118af21';
const E08_720P_MS = '00ff5676ca02d70bf240870776084c57';
const E08_1080P_MS = process.env.PIN_MS_ID_1080P || E08_ITEM;

type Sample = { t: number; text: string };

type ScenarioReport = {
    scenario: string;
    itemId: string;
    versionPlayed: string;
    mediaSourceId: string;
    playMethod: string | null;
    autoSelectedStreamIndex: number | null;
    autoSelectedTrackTitle: string | null;
    menuSelectedOption: string | null;
    menuOptions: string[];
    samples: Sample[];
};

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
    // BODY; a URL rewrite is silently overridden by it. Rewrite the body.
    await page.route(/\/Items\/.+\/PlaybackInfo/, async route => {
        const req = route.request();
        if (req.method() !== 'POST') return route.continue();
        let body: Record<string, unknown> = {};
        try { body = req.postDataJSON() as Record<string, unknown>; } catch (e) {
            console.log('C268-PIN-BODY-PARSE ' + String(e));
        }
        body.MediaSourceId = msId;
        await route.continue({ postData: JSON.stringify(body) });
    });
}

async function beginPlayback(page: import('@playwright/test').Page, itemId: string) {
    const details = `${BASE}/web/#/details?id=${itemId}&serverId=${SERVER_ID}`;
    // A hash-only navigation on the already-loaded app never re-fires
    // "load", so page.goto can hang until the test clock runs out (run4b
    // test 1). Hop to about:blank first to force a real document load.
    if (page.url().indexOf('/web/') !== -1) {
        await page.goto('about:blank').catch(e => console.log('C268-BLANK ' + String(e)));
    }
    try {
        await page.goto(details, { timeout: 60_000 });
    } catch (e) {
        console.log('C268-GOTO-SLOW ' + String(e));
        await page.goto('about:blank').catch(e2 => console.log('C268-BLANK-RETRY ' + String(e2)));
        await page.goto(details, { timeout: 90_000 });
    }
    const btnPlay = page.locator('.mainDetailButtons .btnPlay:visible');
    // The details page can half-render under real host load (observed
    // 2026-09-22: header only, content never arrived); one reload fixes it.
    try {
        await btnPlay.click({ timeout: 45_000 });
    } catch (e) {
        console.log('C268-DETAILS-SLOW ' + String(e));
        await page.reload();
        await btnPlay.click({ timeout: 90_000 });
    }
    await page.waitForURL(/\/video\?id=/, { timeout: 60_000 });
    const video = page.locator('video').first();
    await video.waitFor({ state: 'visible', timeout: 120_000 });
    await video.evaluate((v: HTMLVideoElement) => {
        v.muted = true;
        v.play().catch(e => console.log('C268-AUTOPLAY ' + String(e)));
    });
    await page.waitForTimeout(6000);
    return video;
}

async function probeSession(
    page: import('@playwright/test').Page,
    video: import('@playwright/test').Locator,
    itemId: string
): Promise<{ versionPlayed: string; mediaSourceId: string; playMethod: string | null; subIndex: number | null; subTitle: string | null }> {
    const handle = await video.elementHandle();
    return page.evaluate(async ({ itemId, userId, token, base, video }) => {
        const sessions = await fetch(`${base}/Sessions?ApiKey=${token}`).then(r => r.json());
        // The dev-server browser registers under the reused device name
        // "tools-admin-2026-07-22", NOT "Jellyfin Web" (observed 2026-09-23:
        // run3 left its playback sessions invisible to the old filter and
        // stopMyPlayback therefore never fired). Match on the item and
        // exclude only the real native clients.
        const mine = sessions.filter((s: { Client?: string; NowPlayingItem?: { Id?: string } }) =>
            s.NowPlayingItem && s.NowPlayingItem.Id === itemId
            && (s.Client || '').indexOf('SlopTank') === -1);
        let subIndex: number | null = null;
        let playMethod: string | null = null;
        if (mine.length) {
            subIndex = mine[mine.length - 1].PlayState?.SubtitleStreamIndex ?? null;
            playMethod = mine[mine.length - 1].PlayState?.PlayMethod ?? null;
        } else {
            console.log('C268-SESSION-NOT-FOUND item=' + itemId);
        }
        const detail = await fetch(`${base}/Items/${itemId}?userId=${userId}&Fields=MediaSources&ApiKey=${token}`).then(r => r.json());
        const src = (video as HTMLVideoElement).currentSrc || '';
        let msId = '';
        const q = src.match(/[?&]MediaSourceId=([0-9a-f]{32})/i);
        if (q) msId = q[1];
        else {
            const m = src.match(/([0-9a-f]{32})/gi);
            if (m) msId = m.find(tok => tok.toLowerCase() !== itemId.toLowerCase()) || '';
        }
        let versionPlayed = 'unknown';
        let subTitle: string | null = null;
        for (const ms of detail.MediaSources || []) {
            if (ms.Id === msId || (!msId && ms === detail.MediaSources[0])) {
                versionPlayed = ms.Name || ms.Path || ms.Id;
                const st = (ms.MediaStreams || []).find((s: { Index?: number; Type?: string }) => s.Type === 'Subtitle' && s.Index === subIndex);
                subTitle = st ? st.DisplayTitle || st.Codec : null;
            }
        }
        return { versionPlayed, mediaSourceId: msId, playMethod, subIndex, subTitle };
    }, { itemId, userId: USER_ID, token: TOKEN, base: BASE, video: handle });
}

async function readRendered(video: import('@playwright/test').Locator, page: import('@playwright/test').Page) {
    const native = await video.evaluate((el: HTMLVideoElement) => {
        const showing = Array.from(el.textTracks).find(t => t.mode === 'showing');
        if (!showing || !showing.activeCues || showing.activeCues.length === 0) return '';
        return Array.from(showing.activeCues).map(c => (c as VTTCue).text).join(' | ');
    });
    let custom = '';
    const customLocator = page.locator('.videoSubtitlesInner');
    if (await customLocator.count()) {
        custom = ((await customLocator.textContent({ timeout: 1500 }).catch(e => {
            console.log('C268-CUE-READ ' + String(e));
            return '';
        })) ?? '').trim();
    }
    return { native, custom };
}

async function sampleWindow(
    video: import('@playwright/test').Locator,
    page: import('@playwright/test').Page,
    target: number,
    windowMs: number,
    shotName: string
): Promise<Sample[]> {
    await video.evaluate((el: HTMLVideoElement, t) => {
        el.currentTime = t;
        el.play().catch(e => console.log('C268-SEEKPLAY ' + String(e)));
    }, target);
    const out: Sample[] = [];
    const deadline = Date.now() + windowMs;
    let shotTaken = false;
    while (Date.now() < deadline) {
        await page.waitForTimeout(600);
        const t = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
        const { native, custom } = await readRendered(video, page);
        const text = (custom || native || '').trim();
        out.push({ t: Math.round(t * 10) / 10, text });
        if (!shotTaken && text) {
            await page.screenshot({ path: `${SHOT_DIR}/${shotName}` });
            shotTaken = true;
        }
    }
    if (!shotTaken) await page.screenshot({ path: `${SHOT_DIR}/${shotName}` });
    return out;
}

async function probeSubtitleMenu(page: import('@playwright/test').Page): Promise<{ menuOptions: string[]; menuSelectedOption: string | null }> {
    // Read-only: opening the sheet never changes the selection. The selected
    // option is the one whose check icon is visible.
    try {
        await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    } catch (e) {
        console.log('C268-MENU-OPEN-FAILED ' + String(e));
        return { menuOptions: [], menuSelectedOption: null };
    }
    const sheet = page.locator('.actionSheet:visible');
    try {
        await sheet.locator('button').first().waitFor({ state: 'visible', timeout: 15_000 });
    } catch (e) {
        console.log('C268-MENU-SHEET-FAILED ' + String(e));
        return { menuOptions: [], menuSelectedOption: null };
    }
    const info = await sheet.locator('button').evaluateAll(btns => btns.map(b => {
        const icon = b.querySelector('.actionsheetMenuItemIcon');
        const vis = icon ? window.getComputedStyle(icon).visibility : 'absent';
        return { text: (b.textContent || '').trim(), visible: vis === 'visible' };
    }));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    return {
        menuOptions: info.map(i => i.text),
        menuSelectedOption: (info.find(i => i.visible) || { text: null }).text
    };
}

async function stopMyPlayback(page: import('@playwright/test').Page, itemId: string) {
    await page.evaluate(async ({ itemId, token, base }) => {
        const sessions = await fetch(`${base}/Sessions?ApiKey=${token}`).then(r => r.json());
        const mine = sessions.filter((s: { Client?: string; NowPlayingItem?: { Id?: string } }) =>
            s.NowPlayingItem && s.NowPlayingItem.Id === itemId
            && (s.Client || '').indexOf('SlopTank') === -1);
        for (const s of mine) {
            await fetch(`${base}/Sessions/${s.Id}/Playing/Stop`, { method: 'POST' });
        }
    }, { itemId, token: TOKEN, base: BASE }).catch(e => console.log('C268-STOP ' + String(e)));
}

async function runScenario(
    page: import('@playwright/test').Page,
    opts: {
        scenario: string; itemId: string; pinMsId?: string;
        windows: { t: number; shot: string }[]; windowMs?: number;
        selectEnglishThenReplay?: boolean;
        selectText?: string;
    }
): Promise<ScenarioReport[]> {
    const reports: ScenarioReport[] = [];
    const pass = async (selectFirst = false) => {
        if (opts.pinMsId) await pinVersion(page, opts.pinMsId);
        const video = await beginPlayback(page, opts.itemId);
        if (selectFirst) {
            // One user-style selection of the advertised track, used only by
            // the replay pass to model a returning user.
            const text = opts.selectText || 'English';
            try {
                await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
                const option = page.locator(`.actionSheet:visible button:has-text("${text}")`).first();
                await option.waitFor({ state: 'visible', timeout: 10_000 });
                await option.click();
                await page.waitForTimeout(2000);
            } catch (e) {
                console.log('C268-SELECT-TRACK-FAILED ' + String(e));
            }
        }
        const session = await probeSession(page, video, opts.itemId);
        const menu = await probeSubtitleMenu(page);
        const samples: Sample[] = [];
        for (const w of opts.windows) {
            const s = await sampleWindow(video, page, w.t, opts.windowMs ?? 5000, w.shot);
            samples.push(...s);
        }
        await stopMyPlayback(page, opts.itemId);
        reports.push({
            scenario: opts.scenario + (selectFirst ? ' (replay after one English selection)' : ''),
            itemId: opts.itemId,
            versionPlayed: session.versionPlayed,
            mediaSourceId: session.mediaSourceId,
            playMethod: session.playMethod,
            autoSelectedStreamIndex: session.subIndex,
            autoSelectedTrackTitle: session.subTitle,
            menuSelectedOption: menu.menuSelectedOption,
            menuOptions: menu.menuOptions,
            samples
        });
        console.log(`C268-FINAL ${JSON.stringify(reports[reports.length - 1], null, 1)}`);
        expect(session.versionPlayed, 'must identify the played version').not.toBe('unknown');
    };
    await pass(false);
    if (opts.selectEnglishThenReplay) await pass(true);
    return reports;
}

test('E08 720p pinned: auto-selection and in-sync English', async ({ page }) => {
    test.setTimeout(360_000);
    await seedAndGoto(page, `${BASE}/web/`);
    await runScenario(page, {
        scenario: 'e08-720p',
        itemId: E08_ITEM,
        pinMsId: E08_720P_MS,
        selectEnglishThenReplay: true,
        windows: [
            { t: 26, shot: 'e08-720p-t26.png' },
            { t: 35, shot: 'e08-720p-t35.png' }
        ]
    });
});

test('E08 1080p pinned: auto-selection (fresh, then returning user) and in-sync English', async ({ page }) => {
    test.setTimeout(420_000);
    await seedAndGoto(page, `${BASE}/web/`);
    await runScenario(page, {
        scenario: 'e08-1080p',
        itemId: E08_ITEM,
        pinMsId: E08_1080P_MS,
        selectEnglishThenReplay: true,
        windows: [
            { t: 63, shot: 'e08-1080p-t63.png' },
            { t: 69, shot: 'e08-1080p-t69.png' }
        ]
    });
});

test('E06 720p pinned: retimed sidecar, in sync at head + late anchor', async ({ page }) => {
    test.setTimeout(300_000);
    await seedAndGoto(page, `${BASE}/web/`);
    await runScenario(page, {
        scenario: 'e06-720p-retimed',
        itemId: 'f5ea8bb3f2e9085d296563c1a51777bf',
        pinMsId: 'd3e29999af7388d16b22a579a87e6a65',
        selectEnglishThenReplay: true,
        windows: [
            { t: 90, shot: 'e06-720p-t90.png' },
            { t: 2202, shot: 'e06-720p-t2202.png' }
        ]
    });
});

test('E05 720p pinned: internal Default track serves in sync', async ({ page }) => {
    test.setTimeout(300_000);
    await seedAndGoto(page, `${BASE}/web/`);
    await runScenario(page, {
        scenario: 'e05-720p-internal',
        itemId: 'de7ea706f6c9fa3ee1b523e5a2927094',
        pinMsId: '3eabe5304228f66ca75ece5278d9cf7d',
        selectEnglishThenReplay: true,
        selectText: 'Undefined - Default',
        windows: [
            { t: 30, shot: 'e05-720p-t30.png' },
            { t: 80, shot: 'e05-720p-t80.png' }
        ]
    });
});

test('E01 720p pinned: shifted sidecar in sync at head, mid and late anchors', async ({ page }) => {
    test.setTimeout(360_000);
    await seedAndGoto(page, `${BASE}/web/`);
    await runScenario(page, {
        scenario: 'e01-720p-shifted',
        itemId: '8e8a6c016a072694fecb6128c02e812e',
        pinMsId: '0748062aee37de86f1734384d8a0e376',
        selectEnglishThenReplay: true,
        windows: [
            { t: 102, shot: 'e01-720p-t102.png' },
            { t: 1496, shot: 'e01-720p-t1496.png' },
            { t: 3079, shot: 'e01-720p-t3079.png' }
        ],
        windowMs: 4500
    });
});

test('E02 720p pinned: shifted sidecar in sync at head and tail', async ({ page }) => {
    test.setTimeout(300_000);
    await seedAndGoto(page, `${BASE}/web/`);
    await runScenario(page, {
        scenario: 'e02-720p-shifted',
        itemId: '53c84a8dd81af9b7a65ed91958fb490a',
        pinMsId: '1885a5b51a0fa8da79c30d8cc3d60d12',
        selectEnglishThenReplay: true,
        selectText: 'English',
        windows: [
            { t: 31, shot: 'e02-720p-t31.png' },
            { t: 2900, shot: 'e02-720p-t2900.png' }
        ],
        windowMs: 4500
    });
});
