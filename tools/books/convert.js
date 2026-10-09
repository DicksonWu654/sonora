const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('../narration/config');
async function main() {
  const args = process.argv.slice(2);
  const file = args.shift();
  if (!file) throw new Error('Usage: npm run convert -- /path/to/book.epub [--preview] [--title "Book title"] [--voice af_heart]');
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const { text } = JSON.parse(execFileSync(config.python, [path.join(__dirname, 'extract.py'), path.resolve(file)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const base = process.env.SONORA_URL || 'http://127.0.0.1:8787';
  const response = await fetch(base + '/api/books', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, title: option('--title') || path.basename(file, path.extname(file)), voice: option('--voice') || 'af_heart', preview: args.includes('--preview') }) });
  let job = await response.json();
  if (!response.ok) throw new Error(job.error || 'Could not start conversion.');
  console.log(`Saved job ${job.id}: ${job.title} (${job.total} passages)`);
  let prior = '';
  while (!['complete', 'failed'].includes(job.state)) {
    const status = `${job.state}: ${job.completed}/${job.total}`;
    if (status !== prior) { console.log(status); prior = status; }
    await new Promise(resolve => setTimeout(resolve, 2000));
    job = await fetch(`${base}/api/books/${job.id}`).then(r => r.json());
  }
  if (job.state === 'failed') throw new Error(`Job ${job.id} stopped: ${job.error}. Retry from the studio; saved passages are retained.`);
  console.log(`Ready: ${base}${job.audioUrl} (${Math.round(job.duration)} seconds)`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
