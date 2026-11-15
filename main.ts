// token-radar-01 entry point (Node 22, standard library only).
//
// Reads the sealed snapshot, fits the peer model in lib/model.ts, writes the ranked board and the
// dashboard's data beside the page, copies dashboard/ and screenshots/ across, and writes dossier.json
// with the vendored make.fun library. Offline and deterministic: no clock, no network, no randomness.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//   node main.ts                       (in the grader: /input/snapshot.json, /output)

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const shotsSrc = arg('screenshots', join(here, 'screenshots'));

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { build, radar } = buildRadar(snapshot);
const issue = boardIssue(build.rows, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ model: radar.model_version, as_of: radar.as_of, rows: build.rows })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied.sort();
}

// A stale dashboard or screenshots directory would leak a previous run's files into the dossier.
for (const dir of ['dashboard', 'screenshots']) rmSync(join(out, dir), { recursive: true, force: true });
const pageFiles = copyDir(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyDir(shotsSrc, join(out, 'screenshots'));

if (!pageFiles.includes('index.html')) {
  process.stderr.write('token radar: dashboard/index.html is missing\n');
  process.exit(1);
}
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }));

const v = radar.validation;
process.stdout.write(
  `token radar: ${radar.counts.protocols} protocols, ${radar.counts.peers} live peers fitted, ${radar.counts.pre_token} record no token, ` +
    `${radar.counts.excluded} excluded, ${build.rows.length} rows, ${radar.counts.watchlist_covered}/${radar.counts.watchlist} watchlist covered\n` +
    `token radar: LOO n=${v.n} RMSLE ${v.rmsle.toFixed(3)} MdAPE ${(v.mdape * 100).toFixed(0)}% within2x ${(v.within_2x * 100).toFixed(0)}% vs naive RMSLE ${v.naive_rmsle.toFixed(3)} ` +
    `within2x ${(v.naive_within_2x * 100).toFixed(0)}%; band x${v.ratio_quantiles.p10.toFixed(2)}..x${v.ratio_quantiles.p90.toFixed(2)}\n` +
    `token radar: top 5 ${build.rows.slice(0, 5).map((r) => `${r.slug} $${Math.round(r.implied_value_usd / 1e6)}M`).join(', ')}\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length}), dossier.json\n`,
);
