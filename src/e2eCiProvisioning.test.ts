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
        '--username', 'ci-user',
        '--password', ciCredential,
        '--item-name', 'ci-e2e-fixture',
        '--transcode-item-name', 'ci-e2e-transcode',
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
    it('bootstraps the server, scans the fixture, and emits Playwright configuration', async () => {
        const requests: RecordedRequest[] = [];
        let itemPolls = 0;
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
                case 'GET /Items': {
                    itemPolls += 1;
                    const isTranscodeFixture = request.url?.includes('SearchTerm=ci-e2e-transcode');
                    const document = isTranscodeFixture ?
                        { Items: [ { Id: 'item-2', Name: 'ci-e2e-transcode' } ] } :
                        { Items: itemPolls === 1 ? [] : [ { Id: 'item-1', Name: 'ci-e2e-fixture' } ] };
                    respondJson(response, 200, document);
                    break;
                }
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
            'E2E_SERVER_ID=server-1'
        ]);
        expect(requests).toEqual(expect.arrayContaining([
            { method: 'POST', url: '/Startup/User' },
            expect.objectContaining({ method: 'POST', url: expect.stringContaining('/Library/VirtualFolders?') }),
            { method: 'POST', url: '/Startup/Complete' },
            { method: 'POST', url: '/Users/user-1/Policy' }
        ]));
        expect(startupReadinessPolls).toBe(2);
        expect(startupUserInitialized).toBe(true);
    });

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
});
