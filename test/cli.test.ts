import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

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
  assert.match(result.stderr, /1 page/);
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
  assert.match(run(['--nope']).stderr, /unknown option --nope/);
  assert.equal(run(['--nope']).code, 1);
  assert.match(run(['/no/such/file.md']).stderr, /cannot read/);
  assert.match(run([fixture('x'), '-s', 'a9']).stderr, /unknown page size/);
  assert.match(run([fixture('x'), '-m', 'huge']).stderr, /invalid length/);
  assert.match(run([fixture('x'), '-m', '200mm']).stderr, /margins leave no room/);
  assert.match(run([fixture('x'), '--line-height', 'zero']).stderr, /positive number/);
  assert.match(run([fixture('x'), '-o']).stderr, /requires a value/);
  assert.match(run([fixture('x'), 'extra.md']).stderr, /unexpected extra argument/);
});

test('--help exits successfully and prints usage', () => {
  const result = run(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout.toString(), /Usage/);
});

test('no arguments prints usage and fails', () => {
  const result = run([]);
  assert.equal(result.code, 1);
  assert.match(result.stdout.toString(), /Usage/);
});

test('an empty document still produces one valid page', () => {
  const result = run([fixture(''), '-o', '-']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.toString('latin1'), /\/Type \/Page\b/);
});
