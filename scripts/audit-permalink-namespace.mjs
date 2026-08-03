import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const grammar = JSON.parse(fs.readFileSync(
    path.join(root, 'src/components/router/permalink-grammar-v1.json'),
    'utf8'
));
const patterns = Object.values(grammar.patterns).map(pattern => new RegExp(pattern));
const extensions = new Set([ '.html', '.js', '.json', '.jsx', '.ts', '.tsx' ]);
const legacyRoutePattern = /#(!?)\//;
// eslint-disable-next-line sonarjs/regex-complexity -- This finite alternation is the explicit ordinary-route denylist.
const unprefixedRoutePattern = /(["'`])\/(addserver|dashboard|details|forgotpassword|forgotpasswordpin|home|list|livetv|login|lyrics|metadata|mypreferencesmenu|queue|quickconnect|search|selectserver|userprofile|video|wizardstart)(?=[/?"'`])/;

function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(entryPath) : [ entryPath ];
    });
}

const sourceViolations = walk(path.join(root, 'src'))
    .filter(file => extensions.has(path.extname(file)))
    .filter(file => !/\.(?:test|spec)\.[^.]+$/.test(file))
    .filter(file => path.basename(file) !== 'legacyRouteBridge.ts')
    .flatMap(file => {
        const source = fs.readFileSync(file, 'utf8');
        const reasons = [];
        if (legacyRoutePattern.test(source)) reasons.push('legacy hash route');
        if (unprefixedRoutePattern.test(source)) reasons.push('unprefixed ordinary route');
        return reasons.map(reason => `${path.relative(root, file)}: ${reason}`);
    });

if (sourceViolations.length) {
    throw new Error(`Permalink source namespace audit failed:\n${sourceViolations.join('\n')}`);
}

const workerContracts = new Map([
    [ 'src/plugins/pdfPlayer/plugin.js', '/libraries/pdf.worker.js' ],
    [ 'src/plugins/htmlVideoPlayer/plugin.js', '/libraries/subtitles-octopus-worker.js' ],
    [ 'src/plugins/htmlVideoPlayer/plugin.js#pgs', '/libraries/libpgs.worker.js' ],
    [ 'src/plugins/comicsPlayer/plugin.js', '/libraries/worker-bundle.js' ]
]);
for (const [ descriptor, suffix ] of workerContracts) {
    const file = descriptor.split('#')[0];
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (!source.includes('appRouter.baseUrl()')
        || !source.includes(suffix)) {
        throw new Error(`${descriptor} does not resolve ${suffix} from the injected web base.`);
    }
}

if (process.argv.includes('--dist')) {
    const dist = path.join(root, 'dist');
    const collisions = fs.readdirSync(dist)
        .map(name => name.replace(/\.[^.]+$/, ''))
        .filter(name => patterns.some(pattern => pattern.test(name)));

    if (collisions.length) {
        throw new Error(`Built root asset namespace collision: ${collisions.join(', ')}`);
    }

    const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    const baseMarkers = index.match(/<base data-sloptank-web-base href="\/web\/">/g) ?? [];
    if (baseMarkers.length !== 1) {
        throw new Error(`Built index must contain exactly one web-base marker; found ${baseMarkers.length}.`);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
    if (manifest.start_url !== './home' || manifest.scope !== '../') {
        throw new Error('Built manifest does not launch /web/home with deployment-root scope.');
    }

    for (const worker of [
        'pdf.worker.js',
        'subtitles-octopus-worker.js',
        'libpgs.worker.js',
        'worker-bundle.js'
    ]) {
        if (!fs.existsSync(path.join(dist, 'libraries', worker))) {
            throw new Error(`Built worker is missing: libraries/${worker}`);
        }
    }
}

console.log('Permalink namespace audit passed.');
