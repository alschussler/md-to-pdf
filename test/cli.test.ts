import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts');

function run(args: string[], input?: string): { code: number; stdout: Buffer; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr.toString(),
  };
}

function fixture(content: string, name = 'doc.md'): string {
  const dir = mkdtempSync(join(tmpdir(), 'md-to-pdf-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test('converts a file to a sibling PDF by default', () => {
  const path = fixture('# Hello\n\nWorld.');
  const result = run([path]);
  assert.equal(result.code, 0, result.stderr);
  const expected = path.replace(/\.md$/, '.pdf');
  assert.ok(existsSync(expected), `expected ${expected} to exist`);
  assert.equal(readFileSync(expected).subarray(0, 5).toString(), '%PDF-');
  assert.match(result.stdout.toString(), /1 page/);
});

test('nothing but the PDF reaches stdout when writing to stdout', () => {
  const result = run(['-', '-o', '-'], '# Piped\n\nBody.');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.subarray(0, 5).toString(), '%PDF-');
  assert.ok(!result.stdout.toString('latin1').includes('page'), 'status text must not pollute stdout');
  assert.equal(result.stderr, '');
});

test('reads stdin and writes stdout', () => {
  const result = run(['-', '-o', '-'], '# Piped\n\nBody.');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.subarray(0, 5).toString(), '%PDF-');
  assert.ok(result.stdout.toString('latin1').endsWith('%%EOF\n'));
});

test('honours page size, orientation and margins', () => {
  const path = fixture('body');
  const a5 = run([path, '-o', '-', '-s', 'a5']).stdout.toString('latin1');
  assert.match(a5, /\/MediaBox \[0 0 419\.53 595\.28\]/);

  const landscape = run([path, '-o', '-', '-s', 'letter', '-l']).stdout.toString('latin1');
  assert.match(landscape, /\/MediaBox \[0 0 792 612\]/);

  const custom = run([path, '-o', '-', '-s', '100mmx4in']).stdout.toString('latin1');
  assert.match(custom, /\/MediaBox \[0 0 283\.4646 288\]/);
});

test('rejects bad input clearly', () => {
  assert.equal(run(['--nope']).code, 1);
  assert.match(run(['--nope']).stderr, /Unknown option '--nope'/);
  assert.match(run(['--nope']).stderr, /Run with --help/);
  assert.match(run(['/no/such/file.md']).stderr, /Cannot read \/no\/such\/file\.md/);
  assert.match(run([fixture('x'), '-s', 'a9']).stderr, /--size expects a3, a4/);
  assert.match(run([fixture('x'), '-m', 'huge']).stderr, /--margin requires a length/);
  assert.match(run([fixture('x'), '-m', '200mm']).stderr, /leaves no room for content/);
  assert.match(run([fixture('x'), '--font-size', '0']).stderr, /--font-size requires a positive/);
  assert.match(run([fixture('x'), '--line-height', 'zero']).stderr, /--line-height requires a positive/);
  assert.match(run([fixture('x'), '-o']).stderr, /argument missing/);
  assert.match(run([fixture('x'), 'extra.md']).stderr, /Expected a single input file/);
  assert.match(run(['--title', 'x']).stderr, /input Markdown file is required/);
});

test('--help exits successfully and prints usage', () => {
  const result = run(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout.toString(), /Usage/);
});

test('no arguments prints usage and exits cleanly', () => {
  const result = run([]);
  assert.equal(result.code, 0);
  assert.match(result.stdout.toString(), /Usage/);
});

test('usage lists every option with its description', () => {
  const usage = run(['--help']).stdout.toString();
  for (const flag of [
    '--output', '--size', '--landscape', '--margin', '--font-size',
    '--line-height', '--title', '--author', '--subject',
    '--no-page-numbers', '--no-compress', '--help',
  ]) {
    assert.match(usage, new RegExp(`${flag}\\s{2,}\\S`), `${flag} missing from usage`);
  }
  assert.match(usage, /-o, --output/, 'short flags should be shown alongside long ones');
});

test('an empty document still produces one valid page', () => {
  const result = run([fixture(''), '-o', '-']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.toString('latin1'), /\/Type \/Page\b/);
});
