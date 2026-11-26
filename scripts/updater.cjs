/**
 * Portable updater — runs with the bundled bin/node, no npm dependencies.
 * Downloads the latest portable zip/tar.gz from GitHub Releases,
 * replaces app files while preserving save/.
 * On Windows, bundled Node (bin/) is staged and copied by update.bat
 * after this process exits, to avoid self-replacement file locks.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = 'PocketRisu/PocketRisu';
const ROOT = path.resolve(__dirname, '..');

const isWin = process.platform === 'win32';
// Top-level entries the installed release shipped, written after each update.
// Entries not in (new package ∪ this manifest) are treated as user files and
// never touched. Absent on installs that predate the manifest — first update
// then manages only what the new package contains.
const MANIFEST_NAME = '.installed-manifest';
const REQUIRED_ENTRIES = ['dist', 'server', 'package.json'];
const REQUIRED_DIST_FILES = ['index.html'];
const REQUIRED_WIN_ENTRIES = ['bin'];
const MANAGED_BACKUP_PATH_ROOTS = new Set(['server', 'dist', 'scripts', 'bin', 'node_modules', '.update-tmp']);

function log(msg) { process.stdout.write(`[updater] ${msg}\n`); }
function error(msg) { process.stderr.write(`[ERROR] ${msg}\n`); process.exit(1); }

function getCurrentVersion() {
    const markerPath = path.join(ROOT, '.installed-version');
    if (fs.existsSync(markerPath)) {
        return fs.readFileSync(markerPath, 'utf-8').trim();
    }
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
        return 'v' + pkg.version;
    } catch {
        return 'unknown';
    }
}

// If the user moved the server-backup directory to a custom location *inside*
// ROOT (e.g. <ROOT>/data/backups), the server writes the absolute path here so
// the updater can preserve the top-level segment instead of wiping it.
// Outside-ROOT paths return null (updater never touches them anyway).
function getCustomBackupKeepEntry() {
    const markerPath = path.join(ROOT, 'save', '__backup_path');
    try {
        if (!fs.existsSync(markerPath)) return null;
        const raw = fs.readFileSync(markerPath, 'utf-8').trim();
        if (!raw) return null;
        const abs = path.resolve(raw);
        const rel = path.relative(ROOT, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
        if (!rel) {
            error('Custom backup directory points at the PocketRisu app root. Move it to a separate folder before updating.');
        }
        const top = rel.split(path.sep)[0];
        if (MANAGED_BACKUP_PATH_ROOTS.has(top)) {
            error(`Custom backup directory is inside PocketRisu app files (${rel}). Move it to a separate folder such as data/backups before updating.`);
        }
        return top || null;
    } catch {
        return null;
    }
}

function readInstalledManifest() {
    try {
        const entries = fs.readFileSync(path.join(ROOT, MANIFEST_NAME), 'utf-8')
            .split('\n').map(s => s.trim()).filter(Boolean);
        return { exists: true, entries };
    } catch {
        return { exists: false, entries: [] };
    }
}

const MAX_REDIRECTS = 10;

function httpsGet(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        const get = url.startsWith('https') ? https.get : http.get;
        get(url, { headers: { 'User-Agent': 'PocketRisu-Updater' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsGet(res.headers.location, redirectCount + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function downloadToFile(url, dest, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        const file = fs.createWriteStream(dest);
        const get = url.startsWith('https') ? https.get : http.get;
        get(url, { headers: { 'User-Agent': 'PocketRisu-Updater' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                fs.unlinkSync(dest);
                return downloadToFile(res.headers.location, dest, redirectCount + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const total = parseInt(res.headers['content-length'] || '0', 10);
            let downloaded = 0;
            res.on('data', (chunk) => {
                downloaded += chunk.length;
                if (total > 0) {
                    const pct = ((downloaded / total) * 100).toFixed(1);
                    process.stdout.write(`\r[updater] Downloading... ${pct}%  `);
                }
            });
            res.pipe(file);
            file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
            file.on('error', reject);
        }).on('error', reject);
    });
}

function getPlatformSuffix() {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    if (isWin) return `win-${arch}`;
    if (process.platform === 'darwin') return `macos-${arch}`;
    return `linux-${arch}`;
}

function resolveExtractedRoot(extractedDir) {
    const entries = fs.readdirSync(extractedDir, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) {
        return path.join(extractedDir, entries[0].name);
    }
    return extractedDir;
}

function validateExtractedRoot(extractedRoot) {
    for (const entry of REQUIRED_ENTRIES) {
        if (!fs.existsSync(path.join(extractedRoot, entry))) {
            throw new Error(`Downloaded package is missing required entry: ${entry}`);
        }
    }
    if (isWin) {
        for (const entry of REQUIRED_WIN_ENTRIES) {
            if (!fs.existsSync(path.join(extractedRoot, entry))) {
                throw new Error(`Downloaded Windows package is missing required entry: ${entry}`);
            }
        }
    }
    for (const file of REQUIRED_DIST_FILES) {
        if (!fs.existsSync(path.join(extractedRoot, 'dist', file))) {
            throw new Error(`Downloaded package is missing dist/${file}`);
        }
    }
}

function restoreBackupIntoRoot(backupDir, overwrite = true) {
    if (!fs.existsSync(backupDir)) return;
    for (const entry of fs.readdirSync(backupDir)) {
        const src = path.join(backupDir, entry);
        const dest = path.join(ROOT, entry);
        try {
            if (overwrite && fs.existsSync(dest)) {
                fs.rmSync(dest, { recursive: true, force: true });
            }
            if (!fs.existsSync(dest)) {
                fs.renameSync(src, dest);
            }
        } catch { /* best effort */ }
    }
}

function listFilesRecursive(dir, baseDir = dir, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            listFilesRecursive(fullPath, baseDir, files);
            continue;
        }
        if (entry.isFile()) {
            files.push(path.relative(baseDir, fullPath));
        }
    }
    files.sort();
    return files;
}

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function areDirectoriesEquivalent(a, b) {
    const filesA = listFilesRecursive(a);
    const filesB = listFilesRecursive(b);
    if (filesA.length !== filesB.length) return false;

    for (let i = 0; i < filesA.length; i += 1) {
        if (filesA[i] !== filesB[i]) return false;
        const left = path.join(a, filesA[i]);
        const right = path.join(b, filesB[i]);
        const leftStat = fs.statSync(left);
        const rightStat = fs.statSync(right);
        if (leftStat.size !== rightStat.size) return false;
        if (hashFile(left) !== hashFile(right)) return false;
    }

    return true;
}

async function main() {
    const current = getCurrentVersion();
    log(`Current version: ${current}`);
    log('Checking for updates...');

    const data = await httpsGet(`https://api.github.com/repos/${REPO}/releases/latest`);
    const release = JSON.parse(data.toString());
    const latest = release.tag_name;

    if (!latest) error('Could not determine latest version.');

    if (current === latest) {
        log(`Already up to date (${current}).`);
        return;
    }

    log(`New version available: ${latest}`);

    const suffix = getPlatformSuffix();
    const asset = (release.assets || []).find(a => a.name.includes(suffix));
    if (!asset) {
        error(`No portable package found for ${suffix}. Download manually from:\n  ${release.html_url}`);
    }

    const tmpDir = path.join(ROOT, '.update-tmp');
    if (fs.existsSync(tmpDir)) {
        const prevBackup = path.join(tmpDir, 'backup');
        if (fs.existsSync(prevBackup)) {
            log('Restoring files from previous interrupted update...');
            restoreBackupIntoRoot(prevBackup, true);
        }
        fs.rmSync(tmpDir, { recursive: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });

    const downloadPath = path.join(tmpDir, asset.name);
    log(`Downloading ${asset.name}...`);
    await downloadToFile(asset.browser_download_url, downloadPath);

    log('Extracting...');
    const extractedPath = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractedPath, { recursive: true });
    if (asset.name.endsWith('.zip')) {
        execSync(`powershell -Command "Expand-Archive -Path '${downloadPath}' -DestinationPath '${extractedPath}' -Force"`, { stdio: 'inherit' });
    } else {
        execSync(`tar -xzf "${downloadPath}" -C "${extractedPath}"`, { stdio: 'inherit' });
    }

    const extractedDir = path.join(tmpDir, 'extracted');
    const extractedRoot = resolveExtractedRoot(extractedDir);
    validateExtractedRoot(extractedRoot);
    const currentBin = path.join(ROOT, 'bin');
    const newBin = path.join(extractedRoot, 'bin');
    const skipBinReplacement = fs.existsSync(currentBin)
        && fs.existsSync(newBin)
        && areDirectoriesEquivalent(currentBin, newBin);
    if (skipBinReplacement) {
        log('Bundled Node unchanged; skipping bin/ replacement.');
    }

    // The certificate folder is not in the package: carry it into the new
    // server/ before Phase 1 moves the old one out (the in-app updater does the same).
    const sslSrc = path.join(ROOT, 'server', 'node', 'ssl', 'certificate');
    if (fs.existsSync(sslSrc)) {
        const sslDst = path.join(extractedRoot, 'server', 'node', 'ssl', 'certificate');
        fs.mkdirSync(path.dirname(sslDst), { recursive: true });
        fs.cpSync(sslSrc, sslDst, { recursive: true });
        log('Keeping SSL certificates.');
    }

    // Phase 1: move old files to backup (safer than immediate delete)
    log('Replacing files...');
    const keep = new Set(['save', 'backups', '.installed-version', MANIFEST_NAME, '.update-tmp', 'scripts', '.env', '.npmrc', '.portable']);
    if (isWin || skipBinReplacement) keep.add('bin');
    const customBackupKeep = getCustomBackupKeepEntry();
    if (customBackupKeep && !keep.has(customBackupKeep)) {
        log(`Preserving custom backup directory: ${customBackupKeep}/`);
        keep.add(customBackupKeep);
    }
    const newEntries = fs.readdirSync(extractedRoot);
    const oldManifest = readInstalledManifest();
    const managed = new Set([...newEntries, ...oldManifest.entries]);
    const backupDir = path.join(tmpDir, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });

    // A user file whose name collides with an entry the new release introduces
    // would be overwritten in Phase 2 — evacuate it to backups/ instead of
    // losing it. Only decidable when a previous manifest exists.
    const isConflict = (entry) => oldManifest.exists
        && !oldManifest.entries.includes(entry) && newEntries.includes(entry);
    const conflictDir = path.join(ROOT, 'backups', `update-conflict-${latest}`);
    // A retried update may have evacuated the same name before — never overwrite
    const conflictDest = (entry) => {
        let dest = path.join(conflictDir, entry);
        for (let n = 1; fs.existsSync(dest); n++) dest = path.join(conflictDir, `${entry}.${n}`);
        return dest;
    };

    const preserved = [];
    for (const entry of fs.readdirSync(ROOT)) {
        if (keep.has(entry)) continue;
        if (!managed.has(entry)) { preserved.push(entry); continue; }
        try {
            if (isConflict(entry)) {
                log(`User file "${entry}" collides with a new app file — moving it to backups/update-conflict-${latest}/`);
                fs.mkdirSync(conflictDir, { recursive: true });
                fs.renameSync(path.join(ROOT, entry), conflictDest(entry));
                continue;
            }
            fs.renameSync(path.join(ROOT, entry), path.join(backupDir, entry));
        } catch (e) {
            log(`Error backing up ${entry}: ${e.message}`);
            log('Restoring files already moved to backup...');
            restoreBackupIntoRoot(backupDir, true);
            error(isWin
                ? 'Update failed because some files are in use. Close the running PocketRisu window/console first, then run update.bat again.'
                : 'Update failed because some files are in use. Stop the running server first, then try again.');
        }
    }
    if (preserved.length) {
        log(`Preserving user files: ${preserved.join(', ')}`);
    }

    // Phase 2: move new files from extracted to root
    const moved = [];
    const skipMove = new Set(['save', 'scripts']);
    if (isWin || skipBinReplacement) skipMove.add('bin');
    try {
        for (const entry of newEntries) {
            if (skipMove.has(entry)) continue;
            const src = path.join(extractedRoot, entry);
            const dest = path.join(ROOT, entry);
            // Phase 1 left the keep entries in place, so the rm below would
            // delete them: an older release shipped an empty backups/ (left by
            // the build's boot test) and replaced the user's server backups.
            if (keep.has(entry) && fs.existsSync(dest)) continue;
            if (fs.existsSync(dest)) {
                fs.rmSync(dest, { recursive: true, force: true });
            }
            fs.renameSync(src, dest);
            moved.push(entry);
        }
        for (const entry of REQUIRED_ENTRIES) {
            if (!moved.includes(entry) && !fs.existsSync(path.join(ROOT, entry))) {
                throw new Error(`Required entry was not installed: ${entry}`);
            }
        }
        for (const file of REQUIRED_DIST_FILES) {
            if (!fs.existsSync(path.join(ROOT, 'dist', file))) {
                throw new Error(`Required file was not installed: dist/${file}`);
            }
        }
    } catch (e) {
        // Restore from backup on failure
        log(`Error moving files: ${e.message}`);
        log('Restoring from backup...');
        restoreBackupIntoRoot(backupDir, true);
        error('Update failed, previous version restored. Please try again.');
    }

    // Phase 3: update scripts/ from new release
    const newScripts = path.join(extractedRoot, 'scripts');
    if (fs.existsSync(newScripts)) {
        if (!fs.existsSync(path.join(ROOT, 'scripts'))) {
            fs.mkdirSync(path.join(ROOT, 'scripts'));
        }
        for (const f of fs.readdirSync(newScripts)) {
            fs.copyFileSync(path.join(newScripts, f), path.join(ROOT, 'scripts', f));
        }
    }

    // Record what this release shipped, so the next update knows which entries
    // are app-managed and can leave everything else (user files) alone.
    fs.writeFileSync(path.join(ROOT, MANIFEST_NAME), newEntries.join('\n') + '\n');

    // Phase 4 (Windows): stage bin/ update for update.bat post-step
    if (isWin) {
        if (!fs.existsSync(newBin)) {
            error('Downloaded Windows package is missing bin/. Update aborted before version finalize.');
        }
        const stagedBin = path.join(tmpDir, 'new-bin');
        const skipBinUpdate = path.join(tmpDir, 'skip-bin-update');
        try { fs.rmSync(stagedBin, { recursive: true, force: true }); } catch { /* noop */ }
        try { fs.rmSync(skipBinUpdate, { force: true }); } catch { /* noop */ }
        if (skipBinReplacement) {
            fs.writeFileSync(skipBinUpdate, 'same');
        } else {
            fs.cpSync(newBin, stagedBin, { recursive: true });
            log('Staged bundled Node update (will be applied after updater exits).');
        }
    }

    // Write version marker after all file replacement is truly complete.
    // On Windows, update.bat finalizes this after bin/ replacement succeeds.
    if (isWin) {
        fs.writeFileSync(path.join(tmpDir, 'latest-version'), latest);
        log('Staged version marker update for post-step finalize.');
    } else {
        fs.writeFileSync(path.join(ROOT, '.installed-version'), latest);
    }

    // Cleanup
    if (isWin) {
        log('Leaving .update-tmp for update.bat post-step cleanup.');
    } else {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
        catch { log('Warning: could not remove .update-tmp, you can delete it manually.'); }
    }

    log(`Update complete! ${current} → ${latest}`);
    log('');
    if (isWin) {
        log('Restart by running PocketRisu.exe');
    } else {
        log('Restart by running ./start.sh');
    }
}

main().catch((e) => error(e.message));
