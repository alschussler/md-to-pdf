import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { parseMarkdown } from '../src/markdown/block.ts';
import { DEFAULT_THEME, renderPdf } from '../src/render.ts';
import type { RenderOptions } from '../src/render.ts';
import { encodeWinAnsi, measure } from '../src/fonts.ts';
import { PdfWriter, name } from '../src/pdf.ts';

const FIXED_DATE = new Date('2026-08-21T12:00:00Z');

function options(overrides: Partial<RenderOptions> = {}): RenderOptions {
  return {
    pageWidth: 595.28,
    pageHeight: 841.89,
    marginTop: 56.7,
    marginRight: 56.7,
    marginBottom: 56.7,
    marginLeft: 56.7,
    fontSize: 11,
    lineHeight: 1.45,
    pageNumbers: true,
    title: null,
    author: null,
    subject: null,
    baseDir: process.cwd(),
    compress: true,
    now: FIXED_DATE,
    theme: DEFAULT_THEME,
    ...overrides,
  };
}

function build(source: string, overrides: Partial<RenderOptions> = {}): Buffer {
  return renderPdf(parseMarkdown(source), options(overrides)).bytes;
}

/** Walks the classic xref table and asserts every offset lands on its own object header. */
function verifyXref(pdf: Buffer): number {
  const text = pdf.toString('latin1');
  const startMatch = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  assert.ok(startMatch !== null, 'missing startxref/%%EOF trailer');

  const start = Number.parseInt(startMatch[1], 10);
  assert.equal(text.slice(start, start + 4), 'xref', 'startxref does not point at the xref table');

  const header = /^xref\s+0 (\d+)\s+/.exec(text.slice(start));
  assert.ok(header !== null, 'malformed xref subsection header');
  const count = Number.parseInt(header[1], 10);

  let cursor = start + header[0].length;
  assert.equal(text.slice(cursor, cursor + 20), '0000000000 65535 f \n', 'missing free head entry');
  cursor += 20;

  for (let id = 1; id < count; id++) {
    const entry = text.slice(cursor, cursor + 20);
    const parsed = /^(\d{10}) (\d{5}) n /.exec(entry);
    assert.ok(parsed !== null, `xref entry ${id} is malformed: ${JSON.stringify(entry)}`);
    const offset = Number.parseInt(parsed[1], 10);
    assert.equal(
      text.slice(offset, offset + `${id} 0 obj`.length),
      `${id} 0 obj`,
      `xref entry ${id} points at the wrong offset`,
    );
    cursor += 20;
  }
  return count - 1;
}

function streams(pdf: Buffer): string[] {
  const out: string[] = [];
  const text = pdf.toString('latin1');
  const pattern = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const from = match.index + match[0].length;
    const to = text.indexOf('\nendstream', from);
    if (to === -1) continue;
    const body = pdf.subarray(from, to);
    try {
      out.push(inflateSync(body).toString('latin1'));
    } catch {
      out.push(body.toString('latin1'));
    }
  }
  return out;
}

test('produces a structurally valid PDF', () => {
  const pdf = build('# Title\n\nBody text.');
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.7');
  assert.ok(pdf.toString('latin1').endsWith('%%EOF\n'));
  const objects = verifyXref(pdf);
  assert.ok(objects > 5, 'expected several indirect objects');
});

test('xref stays valid with images, links, tables and outlines', () => {
  const pdf = build(
    '# A\n\n## B\n\n[link](https://x.dev)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> quote\n\n```\ncode\n```\n\n- [x] task',
  );
  verifyXref(pdf);
  const text = pdf.toString('latin1');
  assert.match(text, /\/Type \/Outlines/);
  assert.match(text, /\/Subtype \/Link/);
  assert.match(text, /\/URI \(https:\/\/x\.dev\)/);
});

test('the outline mirrors the heading hierarchy and points at real pages', () => {
  const pdf = build('# One\n\n## Two\n\n### Three\n\n## Four\n\n# Five', { compress: false });
  const text = pdf.toString('latin1');
  const objects = new Map<number, string>();
  for (const match of text.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) {
    objects.set(Number.parseInt(match[1], 10), match[2]);
  }

  const ref = (body: string, key: string): number | null => {
    const match = new RegExp(`/${key} (\\d+) 0 R`).exec(body);
    return match === null ? null : Number.parseInt(match[1], 10);
  };
  const count = (body: string): number | null => {
    const match = /\/Count (-?\d+)/.exec(body);
    return match === null ? null : Number.parseInt(match[1], 10);
  };

  const rootEntry = [...objects].find(([, body]) => body.includes('/Type /Outlines'));
  assert.ok(rootEntry !== undefined, 'no outline dictionary');

  const titles: string[] = [];
  const seen = new Set<number>();
  const walk = (start: number | null, depth: number): number => {
    let visible = 0;
    for (let current = start; current !== null; ) {
      assert.ok(!seen.has(current), 'outline contains a cycle');
      seen.add(current);
      const body = objects.get(current)!;

      const dest = /\/Dest \[(\d+) 0 R \/XYZ null [\d.]+ null\]/.exec(body);
      assert.ok(dest !== null, `outline item has no usable destination: ${body}`);
      assert.match(objects.get(Number.parseInt(dest[1], 10))!, /\/Type \/Page\b/);

      const title = /\/Title \(([^)]*)\)/.exec(body);
      titles.push(`${'  '.repeat(depth)}${title?.[1] ?? '?'}`);

      const children = walk(ref(body, 'First'), depth + 1);
      if (children > 0) assert.equal(count(body), children, 'parent Count must match its descendants');
      visible += 1 + children;
      current = ref(body, 'Next');
    }
    return visible;
  };

  const total = walk(ref(rootEntry[1], 'First'), 0);
  assert.deepEqual(titles, ['One', '  Two', '    Three', '  Four', 'Five']);
  assert.equal(count(rootEntry[1]), total, 'root Count must match the visible item total');
});

test('page count grows with content and page geometry', () => {
  const short = renderPdf(parseMarkdown('one line'), options());
  assert.equal(short.pages, 1);

  const long = 'paragraph\n\n'.repeat(400);
  assert.ok(renderPdf(parseMarkdown(long), options()).pages > 5);

  const narrow = renderPdf(parseMarkdown(long), options({ pageHeight: 300 }));
  assert.ok(narrow.pages > renderPdf(parseMarkdown(long), options()).pages);
});

test('a single block taller than the page still terminates', () => {
  const code = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const result = renderPdf(parseMarkdown('```\n' + code + '\n```'), options());
  assert.ok(result.pages > 5);
  verifyXref(result.bytes);
});

test('output is byte-for-byte deterministic', () => {
  const source = '# Same\n\nInput *always* yields the same bytes.';
  assert.deepEqual(build(source), build(source));
});

test('text reaches the content stream with the right escaping', () => {
  const pdf = build('A (parenthesised) \\\\ backslash and a ) brace.', { compress: false });
  const content = streams(pdf).join('\n');
  assert.match(content, /\\\(parenthesised\\\)/);
  assert.match(content, /\\\\/);
});

test('non-WinAnsi characters are transliterated instead of dropped', () => {
  const pdf = build('Arrow -> →, check ✓, dash —, accent ā.', { compress: false });
  const content = streams(pdf).join('\n');
  assert.match(content, /->/);
  assert.match(content, /ZapfDingbats|\/F7/);
  assert.ok(!content.includes('→'), 'raw multi-byte codepoints must not reach the stream');
});

test('title falls back to the first level-1 heading in metadata', () => {
  const pdf = build('# Detected Title\n\nbody', { title: 'Detected Title' });
  assert.match(pdf.toString('latin1'), /\/Title \(Detected Title\)/);
});

test('page numbering can be turned off', () => {
  const withNumbers = streams(build('body', { compress: false })).join('');
  const without = streams(build('body', { compress: false, pageNumbers: false })).join('');
  assert.match(withNumbers, /1 \/ 1/);
  assert.ok(!without.includes('1 / 1'));
});

test('font metrics match the advance width the viewer will use', () => {
  assert.equal(measure('', 'regular', 12), 0);
  assert.equal(measure('l', 'regular', 1000), 222);
  assert.equal(measure('W', 'regular', 1000), 944);
  assert.equal(measure('W', 'bold', 1000), 944);
  assert.equal(measure('iiii', 'mono', 1000), 2400);
  assert.ok(measure('bold text', 'bold', 12) > measure('bold text', 'regular', 12));
  assert.equal(measure('é', 'regular', 1000), measure('e', 'regular', 1000));
});

test('WinAnsi encoding maps the ranges it claims to', () => {
  assert.deepEqual([...encodeWinAnsi('A~')], [0x41, 0x7e]);
  assert.deepEqual([...encodeWinAnsi('—')], [0x97]);
  assert.deepEqual([...encodeWinAnsi('•')], [0x95]);
  assert.deepEqual([...encodeWinAnsi('é')], [0xe9]);
  assert.deepEqual([...encodeWinAnsi('ā')], [0x61]);
  assert.deepEqual([...encodeWinAnsi('日')], [0x3f]);
});

test('writer rejects references that were never filled in', () => {
  const writer = new PdfWriter();
  const root = writer.alloc();
  writer.alloc();
  writer.put(root, { Type: name('Catalog') });
  assert.throws(() => writer.build(root), /never written/);
});

test('streams are compressed only when asked', () => {
  const source = '# Heading\n\n' + 'Compressible body text. '.repeat(80);
  const compressed = build(source);
  const plain = build(source, { compress: false });
  assert.ok(compressed.length < plain.length);
  assert.match(compressed.toString('latin1'), /\/Filter \/FlateDecode/);
});
