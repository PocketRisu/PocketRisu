/**
 * Generates a minimal package.json containing only the packages the Node
 * server actually requires at runtime, with versions pinned to pnpm-lock.yaml.
 *
 * The portable packages and the Docker image ship a prebuilt dist/, so the
 * frontend packages in the main package.json (~950MB of the ~1GB prod
 * node_modules) are dead weight there. Installing from the generated file
 * instead ships only the server's dependency closure (~50MB).
 *
 * Package names are discovered by walking the require() graph from the server
 * entry point, so the list needs no manual maintenance. All server requires
 * are static string literals with explicit extensions; anything else fails
 * the walk loudly rather than silently shipping a broken package.
 *
 * Usage: node gen-server-deps.cjs <appRoot> <outDir>
 *   appRoot — directory containing server/, pnpm-lock.yaml, package.json
 *             (scripts/updater.cjs is included as an entry when present)
 *   outDir  — created if missing; package.json is written there
 *
 * The canonical output lives at scripts/portable/server-deps/ (package.json +
 * pnpm-lock.yaml, both committed). CI regenerates and compares against the
 * committed package.json, then installs with --frozen-lockfile, so builds stay
 * fully reproducible down to transitive versions. When server dependencies
 * change, regenerate from the repo root:
 *
 *   node scripts/portable/gen-server-deps.cjs . scripts/portable/server-deps
 *   pnpm --dir scripts/portable/server-deps install --prod --lockfile-only
 *
 * Known limitation: the scan is regex-based, so a require()/import() literal
 * inside a block comment or string would be picked up too. That fails loudly
 * (unknown package → generation error; builtin → filtered), never silently.
 */

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const [appRoot, outDir] = process.argv.slice(2);
if (!appRoot || !outDir) {
    console.error('Usage: node gen-server-deps.cjs <appRoot> <outDir>');
    process.exit(1);
}

const BUILTINS = new Set(builtinModules);
const ENTRIES = ['server/node/server.cjs', 'scripts/updater.cjs'];

function packageName(spec) {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Walk the require()/import() graph, collecting external package names.
// Only static string-literal specifiers are supported; a non-literal argument
// is a hard error so a future refactor cannot silently escape the scan.
function collectExternals(entryFiles) {
    const externals = new Set();
    const visited = new Set();
    const queue = entryFiles.slice();
    while (queue.length > 0) {
        const file = queue.pop();
        if (visited.has(file)) continue;
        visited.add(file);
        const src = fs.readFileSync(file, 'utf-8');
        // Strip line comments so commented-out requires are ignored.
        const code = src.replace(/^\s*\/\/.*$/gm, '');
        const dynamic = code.match(/(?:require|import)\s*\(\s*[^'")\s]/);
        if (dynamic) {
            console.error(`Non-literal require()/import() in ${file}: ${dynamic[0]}...`);
            console.error('Add the target package to the scan manually or make the specifier static.');
            process.exit(1);
        }
        for (const m of code.matchAll(/(?:require|import)\s*\(\s*'([^']+)'\s*\)|(?:require|import)\s*\(\s*"([^"]+)"\s*\)/g)) {
            const spec = m[1] ?? m[2];
            if (spec.startsWith('.')) {
                const resolved = path.resolve(path.dirname(file), spec);
                if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
                    console.error(`Unresolvable relative require '${spec}' in ${file}`);
                    process.exit(1);
                }
                queue.push(resolved);
            } else {
                const name = spec.startsWith('node:') ? spec.slice(5) : spec;
                if (!BUILTINS.has(packageName(name))) {
                    externals.add(packageName(spec));
                }
            }
        }
    }
    return externals;
}

// Extract exact resolved versions of the root importer's dependencies from
// pnpm-lock.yaml (lockfile v9 layout). Line-based on purpose: no YAML parser
// available here, and the importers section layout is stable.
function readLockedVersions(lockfilePath) {
    const lines = fs.readFileSync(lockfilePath, 'utf-8').split('\n');
    const versions = {};
    let inRootImporter = false;
    let inDependencies = false;
    let currentDep = null;
    for (const line of lines) {
        if (/^importers:/.test(line)) { inRootImporter = false; continue; }
        if (/^ {2}\.:/.test(line)) { inRootImporter = true; continue; }
        if (/^ {2}\S/.test(line)) { inRootImporter = false; continue; }
        if (!inRootImporter) continue;
        if (/^ {4}dependencies:/.test(line)) { inDependencies = true; continue; }
        if (/^ {4}\S/.test(line)) { inDependencies = false; continue; }
        if (!inDependencies) continue;
        const depMatch = line.match(/^ {6}(?:'([^']+)'|([^\s':][^':]*)):/);
        if (depMatch) { currentDep = depMatch[1] ?? depMatch[2]; continue; }
        const verMatch = line.match(/^ {8}version: ([^\s(]+)/);
        if (verMatch && currentDep) {
            versions[currentDep] = verMatch[1];
            currentDep = null;
        }
    }
    return versions;
}

const entryFiles = [];
for (const entry of ENTRIES) {
    const p = path.join(appRoot, entry);
    if (fs.existsSync(p)) entryFiles.push(path.resolve(p));
}
if (entryFiles.length === 0) {
    console.error(`No entry files found under ${appRoot} (expected ${ENTRIES.join(', ')})`);
    process.exit(1);
}

const externals = collectExternals(entryFiles);
const locked = readLockedVersions(path.join(appRoot, 'pnpm-lock.yaml'));
const appPkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf-8'));

const dependencies = {};
for (const name of [...externals].sort()) {
    if (!locked[name]) {
        console.error(`Server requires '${name}' but it is not a dependency in pnpm-lock.yaml's root importer.`);
        console.error('Add it to package.json "dependencies" first.');
        process.exit(1);
    }
    dependencies[name] = locked[name];
}

// The app's patchedDependencies patch frontend packages, and the patch files
// are not shipped next to this manifest. A patch on a server dependency would
// have to ship too, so that fails loudly instead of installing it unpatched.
const patched = Object.keys(appPkg.pnpm?.patchedDependencies ?? {});
const patchedServerDeps = patched.filter((spec) => dependencies[spec.replace(/@[^@]*$/, '')]);
if (patchedServerDeps.length > 0) {
    console.error(`Server dependencies are patched (${patchedServerDeps.join(', ')}), which this manifest cannot carry.`);
    process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
    path.join(outDir, 'package.json'),
    JSON.stringify({
        name: 'pocketrisu-server-deps',
        // Fixed version: this file is committed, and tracking the app version
        // would churn it on every release for no benefit.
        version: '0.0.0',
        private: true,
        dependencies,
        // Without this, pnpm 10 blocks dependency build scripts and
        // better-sqlite3's native addon never gets built.
        pnpm: { onlyBuiltDependencies: appPkg.pnpm?.onlyBuiltDependencies },
    }, null, 2) + '\n',
);

console.log(`Server runtime dependencies (${Object.keys(dependencies).length}):`);
for (const [name, version] of Object.entries(dependencies)) {
    console.log(`  ${name}@${version}`);
}
