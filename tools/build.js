// Builds the standalone Soundfield.exe and installs it for the current user.
//   npm run build            package into dist/ and install to %LOCALAPPDATA%\Programs\Soundfield
//   npm run build -- --no-install   package into dist/ only
//   npm run build -- --wait         if Soundfield is open, install as soon as it closes
// Settings, libraries and projects live in %APPDATA%\Soundfield, so they carry over between builds.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'Soundfield');
const SHORTCUT = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Soundfield.lnk');

// Only what the app needs at runtime goes in the package.
const KEEP = new Set(['main.js', 'preload.js', 'package.json', 'lib', 'shared', 'renderer', 'build']);

async function main() {
  const { packager } = await import('@electron/packager');
  console.log(`Packaging Soundfield ${pkg.version}…`);
  const [outDir] = await packager({
    dir: ROOT,
    out: path.join(ROOT, 'dist'),
    name: 'Soundfield',
    executableName: 'Soundfield',
    platform: 'win32',
    arch: 'x64',
    icon: path.join(ROOT, 'build', 'icon.ico'),
    asar: false, // workers are loaded from real files
    overwrite: true,
    prune: true,
    quiet: true,
    ignore: rel => rel !== '' && !KEEP.has(rel.split('/')[1]),
    appVersion: pkg.version,
    buildVersion: `${pkg.version}.${Math.floor(Date.now() / 1000 / 60) % 65535}`,
    win32metadata: {
      CompanyName: 'Soundfield',
      ProductName: 'Soundfield',
      FileDescription: 'Soundfield',
      OriginalFilename: 'Soundfield.exe',
    },
  });
  console.log('Built', path.join(outDir, 'Soundfield.exe'));
  if (process.argv.includes('--no-install')) return;

  // Swap the new build into place. Windows locks a running exe's folder, so a rename fails while it's open.
  const old = INSTALL_DIR + '.old';
  fs.rmSync(old, { recursive: true, force: true });
  // With --wait, keep trying until Soundfield is closed, then install right away.
  const wait = process.argv.includes('--wait');
  let told = false;
  while (fs.existsSync(INSTALL_DIR)) {
    try { fs.renameSync(INSTALL_DIR, old); break; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      if (!wait) {
        console.error('\nSoundfield is open. Close it, then run the build again (or use --wait).');
        process.exit(2);
      }
      if (!told) { console.log('Soundfield is open: the update installs as soon as you close it…'); told = true; }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  fs.mkdirSync(path.dirname(INSTALL_DIR), { recursive: true });
  fs.cpSync(outDir, INSTALL_DIR, { recursive: true });
  fs.rmSync(old, { recursive: true, force: true });

  const exe = path.join(INSTALL_DIR, 'Soundfield.exe');
  const ps = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:SF_LNK);
$s.TargetPath = $env:SF_EXE; $s.Arguments = ''; $s.WorkingDirectory = $env:SF_DIR;
$s.IconLocation = $env:SF_EXE + ',0'; $s.Description = 'Soundfield'; $s.Save()`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, SF_LNK: SHORTCUT, SF_EXE: exe, SF_DIR: INSTALL_DIR },
    stdio: 'inherit',
  });
  console.log('Installed', exe);
  console.log('Start menu shortcut updated:', SHORTCUT);
}

main().catch(e => { console.error(e); process.exit(1); });
