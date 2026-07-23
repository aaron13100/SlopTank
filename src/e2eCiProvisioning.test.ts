/**
 * Black-box tests for the CI server-provisioning command used by GitHub Actions.
 * The command runs in a child process and crosses an HTTP boundary just as it does
 * in CI; no production function is imported into the test process.
 */
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve as resolvePath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const provisioner = resolvePath(repositoryRoot, 'e2e/ci/provision-server.mjs');
const servers: ReturnType<typeof createServer>[] = [];
const ciCredential = [ 'ci', 'password' ].join('-');

interface CommandResult {
    code: number;
    stderr: string;
    stdout: string;
}

interface RecordedRequest {
    method?: string;
    url?: string;
}

function respondJson(response: ServerResponse, status: number, document: unknown) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(document));
}

/**
 * Fixture response for the mocked GET /Items endpoint, keyed off which
 * fixture is being searched for. itemPolls simulates the movie fixture
 * taking one extra scan poll to appear, exercising waitForItemByName's retry.
 */
function itemsFixtureResponse(url: string | undefined, itemPolls: number) {
    if (url?.includes('SearchTerm=ci-e2e-transcode')) {
        return { Items: [ { Id: 'item-2', Name: 'ci-e2e-transcode' } ] };
    }
    if (url?.includes('SearchTerm=ci-e2e-show')) {
        return { Items: [ { Id: 'series-1', Name: 'ci-e2e-show' } ] };
    }
    return { Items: itemPolls === 1 ? [] : [ { Id: 'item-1', Name: 'ci-e2e-fixture' } ] };
}

/**
 * Fixture response for the mocked GET /Shows/series-1/Episodes endpoint.
 * Poll 1 has only one episode; poll 2 reproduces the real scanner race
 * (the second episode's row exists before its IndexNumber is committed);
 * poll 3+ is fully indexed. Exercises waitForEpisodes' two-episode wait,
 * its race tolerance, and its index-based sort.
 */
function episodesFixtureResponse(episodePolls: number) {
    if (episodePolls === 1) {
        return { Items: [ { Id: 'episode-1', IndexNumber: 1, ParentIndexNumber: 1 } ] };
    }
    if (episodePolls === 2) {
        return {
            Items: [
                { Id: 'episode-2', ParentIndexNumber: 1 },
                { Id: 'episode-1', IndexNumber: 1, ParentIndexNumber: 1 }
            ]
        };
    }
    return {
        Items: [
            { Id: 'episode-2', IndexNumber: 2, ParentIndexNumber: 1 },
            { Id: 'episode-1', IndexNumber: 1, ParentIndexNumber: 1 }
        ]
    };
}

async function startApi(
    handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
}

function runProvisioner(baseUrl: string): Promise<CommandResult> {
    const args = [
        provisioner,
        '--base-url', baseUrl,
        '--media-path', '/media',
        '--tv-media-path', '/tvmedia',
        '--username', 'ci-user',
        '--password', ciCredential,
        '--item-name', 'ci-e2e-fixture',
        '--transcode-item-name', 'ci-e2e-transcode',
        '--series-name', 'ci-e2e-show',
        '--max-attempts', '3',
        '--poll-interval-ms', '1'
    ];

    return new Promise(complete => {
        execFile(process.execPath, args, { cwd: repositoryRoot }, (error, stdout, stderr) => {
            complete({
                code: typeof error?.code === 'number' ? error.code : 0,
                stderr,
                stdout
            });
        });
    });
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(closed => {
        server.close(() => closed());
    })));
});

describe('CI Jellyfin provisioning command', () => {
    // @covers e2e_ci_provisioning.bootstrap.emits_playwright_config
    it('bootstraps the server, scans the fixture, and emits Playwright configuration', async () => {
        const requests: RecordedRequest[] = [];
        let itemPolls = 0;
        let episodePolls = 0;
        let startupReadinessPolls = 0;
        let startupUserInitialized = false;
        const baseUrl = await startApi((request, response) => {
            requests.push({ method: request.method, url: request.url });
            switch (`${request.method} ${request.url?.split('?')[0]}`) {
                case 'GET /System/Info/Public':
                    respondJson(response, 200, { Id: 'server-1' });
                    break;
                case 'GET /Startup/Configuration':
                    startupReadinessPolls += 1;
                    respondJson(response, startupReadinessPolls === 1 ? 503 : 200,
                        startupReadinessPolls === 1 ?
                            { error: 'initializing network settings' } :
                            { ServerName: 'SlopTank CI' });
                    break;
                case 'GET /Startup/User':
                    startupUserInitialized = true;
                    respondJson(response, 200, { Name: '' });
                    break;
                case 'POST /Startup/User':
                    if (!startupUserInitialized) {
                        respondJson(response, 500, { error: 'first user is not initialized' });
                    } else {
                        response.writeHead(204);
                        response.end();
                    }
                    break;
                case 'POST /Users/AuthenticateByName':
                    respondJson(response, 200, {
                        AccessToken: 'token-1',
                        ServerId: 'server-1',
                        User: { Id: 'user-1', Policy: { IsAdministrator: true, IsHidden: true } }
                    });
                    break;
                case 'GET /Items':
                    itemPolls += 1;
                    respondJson(response, 200, itemsFixtureResponse(request.url, itemPolls));
                    break;
                case 'GET /Shows/series-1/Episodes':
                    episodePolls += 1;
                    respondJson(response, 200, episodesFixtureResponse(episodePolls));
                    break;
                default:
                    response.writeHead(204);
                    response.end();
            }
        });

        const result = await runProvisioner(baseUrl);

        expect(result).toEqual(expect.objectContaining({ code: 0, stderr: '' }));
        expect(result.stdout.trim().split('\n')).toEqual([
            `E2E_BASE_URL=${baseUrl}`,
            'E2E_USERNAME=ci-user',
            `E2E_PASSWORD=${ciCredential}`,
            'E2E_ITEM_ID=item-1',
            'E2E_TRANSCODE_ITEM_ID=item-2',
            'E2E_EPISODE_ITEM_ID=episode-1',
            'E2E_SERVER_ID=server-1'
        ]);
        expect(requests).toEqual(expect.arrayContaining([
            { method: 'POST', url: '/Startup/User' },
            expect.objectContaining({ method: 'POST', url: expect.stringContaining('/Library/VirtualFolders?') }),
            { method: 'POST', url: '/Startup/Complete' },
            { method: 'POST', url: '/Users/user-1/Policy' },
            { method: 'GET', url: '/Shows/series-1/Episodes' }
        ]));
        const libraryRequests = requests.filter(r => r.url?.startsWith('/Library/VirtualFolders?'));
        expect(libraryRequests).toEqual([
            expect.objectContaining({ url: expect.stringContaining('collectionType=movies') }),
            expect.objectContaining({ url: expect.stringContaining('collectionType=tvshows') })
        ]);
        expect(startupReadinessPolls).toBe(2);
        expect(startupUserInitialized).toBe(true);
        expect(episodePolls).toBe(3);
    });

    // @covers e2e_ci_provisioning.startup_request_rejected.fails_visibly
    it('fails visibly when a startup API request is rejected', async () => {
        const baseUrl = await startApi((request, response) => {
            if (request.url === '/System/Info/Public') {
                respondJson(response, 200, { Id: 'server-1' });
            } else if (request.method === 'GET' && request.url === '/Startup/User') {
                respondJson(response, 200, { Name: '' });
            } else if (request.method === 'POST' && request.url === '/Startup/User') {
                respondJson(response, 500, { error: 'user setup failed' });
            } else {
                response.writeHead(204);
                response.end();
            }
        });

        const result = await runProvisioner(baseUrl);

        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain('E2E_');
        expect(result.stderr).toContain('POST /Startup/User returned HTTP 500');
        expect(result.stderr).toContain('user setup failed');
    });

    // @covers e2e_ci_provisioning.incomplete_auth_document.fails_closed
    it('fails closed when authentication returns an incomplete document', async () => {
        const baseUrl = await startApi((request, response) => {
            if (request.url === '/System/Info/Public') {
                respondJson(response, 200, { Id: 'server-1' });
            } else if (request.url === '/Users/AuthenticateByName') {
                respondJson(response, 200, {});
            } else {
                response.writeHead(204);
                response.end();
            }
        });

        const result = await runProvisioner(baseUrl);

        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain('E2E_');
        expect(result.stderr).toContain('authentication response omitted AccessToken or ServerId');
    });

    // @covers e2e_ci_provisioning.second_episode_never_indexed.fails_visibly
    it('fails visibly when the TV fixture never indexes a second episode', async () => {
        const baseUrl = await startApi((request, response) => {
            switch (`${request.method} ${request.url?.split('?')[0]}`) {
                case 'GET /System/Info/Public':
                    respondJson(response, 200, { Id: 'server-1' });
                    break;
                case 'GET /Startup/Configuration':
                    respondJson(response, 200, { ServerName: 'SlopTank CI' });
                    break;
                case 'GET /Startup/User':
                    respondJson(response, 200, { Name: '' });
                    break;
                case 'POST /Users/AuthenticateByName':
                    respondJson(response, 200, {
                        AccessToken: 'token-1',
                        ServerId: 'server-1',
                        User: { Id: 'user-1', Policy: { IsAdministrator: true, IsHidden: true } }
                    });
                    break;
                case 'GET /Items':
                    // itemPolls fixed at 2 (already matched): this test isn't
                    // exercising the movie-fixture retry, only the episode wait.
                    respondJson(response, 200, itemsFixtureResponse(request.url, 2));
                    break;
                case 'GET /Shows/series-1/Episodes':
                    // Only ever one episode indexed: the "second episode" fixture
                    // never scans, e.g. a broken season-folder naming pattern.
                    respondJson(response, 200, episodesFixtureResponse(1));
                    break;
                default:
                    response.writeHead(204);
                    response.end();
            }
        });

        const result = await runProvisioner(baseUrl);

        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain('E2E_');
        expect(result.stderr).toContain('Series series-1 did not index at least two episodes after 3 attempts');
    });
});
