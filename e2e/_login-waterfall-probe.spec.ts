// SlopTank modification notice: added by SlopTank on 2026-10-01.
import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { login } from './fixtures';

/**
 * Cold-login request waterfall for the live site (task c171). Records every
 * request from page navigation until the same "usable" moment that
 * _latency-probe.spec.ts reports as its login total: login() resolving, i.e.
 * the URL reaching the home route after credential submit. Each request keeps
 * Playwright's request.timing() fields, encoded size, content-encoding and
 * whether it started before that moment (critical path). Long tasks are
 * captured with a PerformanceObserver installed before any page script runs.
 *
 * Env: E2E_USERNAME, E2E_PASSWORD, E2E_BASE_URL, WATERFALL_OUT (json path).
 */
const USERNAME = process.env.E2E_USERNAME as string;
const PASSWORD = process.env.E2E_PASSWORD as string;
const OUT = process.env.WATERFALL_OUT as string;
if (!OUT) {
    throw new Error('Set WATERFALL_OUT to the raw JSON output path'); // allow-raw-error: e2e setup fast-fail, not app code
}

test.setTimeout(180_000);

interface RequestRecord {
    url: string;
    path: string;
    resourceType: string;
    method: string;
    status: number | null;
    startOffsetMs: number | null;
    timing: { startTime: number; domainLookupStart: number; domainLookupEnd: number; connectStart: number; connectEnd: number; secureConnectionStart: number; requestStart: number; responseStart: number; responseEnd: number } | null;
    serverWaitMs: number | null;
    transferMs: number | null;
    durationMs: number | null;
    bodyBytes: number | null;
    headerBytes: number | null;
    contentEncoding: string | null;
    gzip: boolean;
    failed: string | null;
    criticalPath: boolean;
}

test('login waterfall: every request until home is usable', async ({ page }) => {
    await page.addInitScript(() => {
        const w = window as unknown as { __longtasks: Array<{ start: number; duration: number }>; __timeOrigin: number };
        w.__longtasks = [];
        w.__timeOrigin = performance.timeOrigin;
        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                w.__longtasks.push({ start: performance.timeOrigin + e.startTime, duration: e.duration });
            }
        }).observe({ type: 'longtask', buffered: true });
    });

    const pending: Array<Promise<RequestRecord>> = [];
    let t0 = 0;

    const capture = async (request: import('@playwright/test').Request, failed: string | null): Promise<RequestRecord> => {
        const response = failed ? null : await request.response();
        const timing = request.timing();
        let sizes: { responseBodySize: number; responseHeadersSize: number } | null = null;
        try {
            sizes = await request.sizes();
        } catch {
            sizes = null;
        }
        let headers: Record<string, string> = {};
        try {
            headers = response ? await response.allHeaders() : {};
        } catch (cause) {
            // Page closed before headers resolved: record the request without an encoding.
            headers = { 'x-probe-headers-error': String(cause) };
        }
        const enc = headers['content-encoding'] ?? null;
        const url = new URL(request.url());
        const rel = (v: number) => (timing && v >= 0 ? Math.round(v * 10) / 10 : null);
        const rs = rel(timing.responseStart);
        const rq = rel(timing.requestStart);
        const re = rel(timing.responseEnd);
        return {
            url: request.url(),
            path: url.pathname + (url.hash || ''),
            resourceType: request.resourceType(),
            method: request.method(),
            status: response ? response.status() : null,
            // Aborted requests report a negative placeholder startTime: no usable offset.
            startOffsetMs: timing.startTime > 0 ? Math.round(timing.startTime - t0) : null,
            timing: timing && timing.startTime > 0 ? timing : null,
            serverWaitMs: rs !== null && rq !== null ? Math.round((rs - rq) * 10) / 10 : null,
            transferMs: re !== null && rs !== null ? Math.round((re - rs) * 10) / 10 : null,
            durationMs: re !== null ? re : null,
            bodyBytes: sizes ? sizes.responseBodySize : null,
            headerBytes: sizes ? sizes.responseHeadersSize : null,
            contentEncoding: enc,
            gzip: !!enc && /gzip/i.test(enc),
            failed,
            criticalPath: false
        };
    };

    page.on('requestfinished', (request) => {
        pending.push(capture(request, null));
    });
    page.on('requestfailed', (request) => {
        pending.push(capture(request, request.failure()?.errorText ?? 'failed'));
    });

    t0 = Date.now();
    await page.goto('/web/#/login', { waitUntil: 'commit' });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('load');
    await login(page, USERNAME, PASSWORD);
    const t1 = Date.now();
    const loginTotalMs = t1 - t0;

    const longtasks = await page.evaluate(() => (window as unknown as { __longtasks: Array<{ start: number; duration: number }> }).__longtasks);
    const records = await Promise.all(pending);
    const totalBefore = t1 - t0;
    for (const r of records) {
        r.criticalPath = r.startOffsetMs !== null && r.startOffsetMs < totalBefore;
    }
    records.sort((a, b) => (a.startOffsetMs ?? Infinity) - (b.startOffsetMs ?? Infinity));

    // timing.startTime is epoch ms, so offsets above are relative to t0; the
    // long tasks are converted the same way.
    const tasks = longtasks.map((l) => ({ startOffsetMs: Math.round(l.start - t0), durationMs: Math.round(l.duration) }));
    const critical = records.filter((r) => r.criticalPath);
    const lastResponseEnd = Math.max(...critical.map((r) => (r.durationMs !== null && r.startOffsetMs !== null ? r.startOffsetMs + r.durationMs : 0)));

    writeFileSync(OUT, JSON.stringify({
        schema: 1,
        capturedAt: new Date(t1).toISOString(),
        loginTotalMs,
        lastCriticalResponseEndOffsetMs: Math.round(lastResponseEnd),
        usableOffsetMs: totalBefore,
        longtasks: tasks,
        requests: records
    }, null, 2));
    console.log(`WATERFALL total=${loginTotalMs}ms requests=${records.length} critical=${critical.length} longtasks=${tasks.length}`);
});
