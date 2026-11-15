// Deterministic Node entrypoint: validate first, stage complete output, publish only after dossier builds.
import { accessSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const options = new Map<string, string>();
const supported = new Set(['input', 'output', 'screenshots']);
function fail(message: string): never { throw new Error(message); }
function parseOptions() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(args[index]);
    if (!match || !supported.has(match[1])) fail(`Unknown argument: ${args[index]}`);
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith('--')) fail(`Missing value: --${match[1]}`);
    if (options.has(match[1])) fail(`Duplicate option: --${match[1]}`);
    options.set(match[1], value);
  }
}
function listFiles(directory: string, prefix = ''): string[] {
  if (!existsSync(directory)) fail(`Missing artifact directory: ${directory}`);
  const names: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    if (!NAME.test(entry)) fail(`Invalid artifact name: ${entry}`);
    const full = join(directory, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const info = lstatSync(full);
    if (info.isSymbolicLink()) fail(`Artifact symlink refused: ${relative}`);
    if (info.isDirectory()) names.push(...listFiles(full, relative));
    else if (info.isFile()) names.push(relative);
    else fail(`Nonregular artifact: ${relative}`);
  }
  return names;
}
function copyFiles(source: string, destination: string, files: string[]) {
  for (const name of files) {
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, name), target);
  }
}
function contained(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
function run() {
  parseOptions();
  const input = resolve(options.get('input') ?? '/input');
  const snapshotFile = input.endsWith('.json') ? input : join(input, 'snapshot.json');
  const output = resolve(options.get('output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const images = resolve(options.get('screenshots') ?? join(root, 'screenshots'));
  const dashboard = join(root, 'dashboard');
  // Refuse destinations whose replacement could erase source or input.
  if (output === sep || contained(output, resolve(root)) || contained(output, snapshotFile) || contained(output, images) || contained(dashboard, output) || contained(images, output)) {
    fail('Output would contain an input or source directory');
  }
  const snapshot = parseSnapshot(readFileSync(snapshotFile, 'utf8'));
  const { build, radar } = buildRadar(snapshot);
  const issue = boardIssue(build.rows, snapshot);
  if (issue) fail(issue);
  const pages = listFiles(dashboard);
  if (!pages.includes('index.html') || !pages.some(f => f.endsWith('.css')) || !pages.some(f => f.endsWith('.js'))) {
    fail('Dashboard requires index.html, CSS and JS');
  }
  const shots = listFiles(images);
  if (shots.length < 3 || shots.length > 4 || shots.some(f => !/\.(png|jpe?g)$/i.test(f) || f.includes('/'))) {
    fail('Screenshots require three or four top-level PNG/JPEG images');
  }
 let stageParent = dirname(output);
 try {
  accessSync(stageParent, constants.W_OK);
 } catch {
  stageParent = tmpdir();
 }
 const stage = join(stageParent, '.' + basename(output) + '-radar-stage');
  if (existsSync(stage)) fail(`Staging directory already exists: ${stage}`);
  mkdirSync(stage, { recursive: true });
  try {
    writeFileSync(join(stage, 'board.json'), JSON.stringify({ model: radar.model_version, as_of: radar.as_of, rows: build.rows }) + '\n');
    writeFileSync(join(stage, 'data.js'), dataScript(radar));
    copyFiles(dashboard, join(stage, 'dashboard'), pages);
    copyFiles(images, join(stage, 'screenshots'), shots);
    const dossier = buildDossier(stage, { text_max_bytes: 65536 });
    writeFileSync(join(stage, 'dossier.json'), dossier);
    mkdirSync(output, { recursive: true });
    // Replace only owned artifacts; retain unrelated files in a caller-supplied output directory.
    for (const name of ['board.json', 'data.js', 'dashboard', 'screenshots', 'dossier.json']) {
      rmSync(join(output, name), { recursive: true, force: true });
      try {
       renameSync(join(stage, name), join(output, name));
      } catch (error) {
       if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
       cpSync(join(stage, name), join(output, name), { recursive: true, force: true });
       rmSync(join(stage, name), { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const v = radar.validation;
  process.stdout.write(JSON.stringify({
    rows: build.rows.length,
    counts: radar.counts,
    validation: { n: v.n, rmsle: v.rmsle, naive_rmsle: v.naive_rmsle, untilted_rmsle: v.core_only_rmsle, within_2x: v.within_2x },
    top: build.rows.slice(0, 5).map(r => ({ slug: r.slug, implied_value_usd: r.implied_value_usd })),
    artifacts: { dashboard_files: pages.length, screenshots: shots.length },
  }, null, 2) + '\n');
}
try { run(); }
catch (error) {
  process.stderr.write(`token radar: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
