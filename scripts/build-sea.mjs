import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const blobPath = path.join(rootDir, 'sea-prep.blob');
const shouldZip = process.argv.includes('--zip');

const appPaths = [
  'index.js',
  'package.json',
  'README.md',
  'routes',
  'controllers',
  'services',
  'workers',
  'cli',
  'public',
  'views'
];

const run = (command, args, options = {}) => {
  execFileSync(command, args, { stdio: 'inherit', ...options });
};

const runOutput = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', ...options }).trim();

const packageJsonPath = path.join(rootDir, 'package.json');
const packageVersion = runOutput(process.execPath, ['-p', `require(${JSON.stringify(packageJsonPath)}).version`]);
const version = `v${packageVersion}`;

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

run(process.execPath, ['--experimental-sea-config', path.join(rootDir, 'sea-config.json')]);

const platform = process.platform;
const arch = process.arch;
const ext = platform === 'win32' ? '.exe' : '';
const binaryName = `node-ffmpeg-rencode-videos-${platform === 'darwin' ? 'macos' : platform}-${arch}${ext}`;
const binaryPath = path.join(distDir, binaryName);

cpSync(process.execPath, binaryPath);

if (platform === 'darwin') {
  try {
    run('codesign', ['--remove-signature', binaryPath]);
  } catch {
  }
}

const postjectArgs = [
  binaryPath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
];

if (platform === 'darwin') {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}

run(platform === 'win32' ? 'npx.cmd' : 'npx', ['postject', ...postjectArgs]);

if (platform === 'darwin') {
  run('codesign', ['--sign', '-', binaryPath]);
}

const appDir = path.join(distDir, 'app');
mkdirSync(appDir, { recursive: true });

for (const relPath of appPaths) {
  const src = path.join(rootDir, relPath);
  if (!existsSync(src)) continue;
  const dst = path.join(appDir, relPath);
  cpSync(src, dst, { recursive: true });
}

const osName = platform === 'darwin' ? `macos-${arch}` : platform === 'win32' ? `win-${arch}` : `${platform}-${arch}`;
const zipName = `node-ffmpeg-rencode-videos-${version}-${osName}.zip`;

if (shouldZip) {
  const prevCwd = process.cwd();
  process.chdir(distDir);

  if (platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${binaryName}','app' -DestinationPath '${zipName}' -Force`]);
  } else {
    run('zip', ['-r', zipName, binaryName, 'app']);
  }

  process.chdir(prevCwd);
}

if (existsSync(blobPath)) {
  rmSync(blobPath, { force: true });
}

writeFileSync(path.join(distDir, 'SEA_BUILD_INFO.txt'), `${binaryName}\n${zipName}\n`);

console.log(`Built SEA binary: ${binaryPath}`);
if (shouldZip) {
  console.log(`Built SEA zip: ${path.join(distDir, zipName)}`);
}
