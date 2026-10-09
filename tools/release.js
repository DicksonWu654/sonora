const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function assertPublicFiles(files) {
  for (const file of files) {
    if (/(^|\/)(?:\.git|\.runtime|\.cache|\.venv|node_modules|output|dist|\.playwright-cli)(?:\/|$)/.test(file)
      || /(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')
      || /\.(?:epub|pdf|mp3|wav|pth|pt|pem|key|p12|pfx)$/i.test(file)) {
      throw new Error(`Private or generated file is tracked: ${file}. Remove it from Git before packaging.`);
    }
  }
}

function release() {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  if (git(['status', '--porcelain']).trim()) throw new Error('Commit source changes before building a release.');
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  assertPublicFiles(files);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
  const destination = path.join(root, 'dist');
  fs.mkdirSync(destination, { recursive: true });
  const archive = path.join(destination, 'Sonora.zip');
  execFileSync('git', ['archive', 'HEAD', '--format=zip', '--prefix=Sonora/', `--output=${archive}`], { cwd: root, stdio: 'inherit' });
  console.log(`Sonora ${manifest.version}: ${archive}`);
}

if (require.main === module) {
  try { release(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { assertPublicFiles };
