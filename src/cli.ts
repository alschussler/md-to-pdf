#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { parseMarkdown } from './markdown/block.ts';
import { plainText } from './markdown/inline.ts';
import type { Block } from './markdown/types.ts';
import { DEFAULT_THEME, renderPdf } from './render.ts';
import type { RenderOptions } from './render.ts';

const PAGE_SIZES: Record<string, [number, number]> = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
};

const USAGE = `md-to-pdf — convert Markdown to PDF with zero dependencies

Usage
  node src/cli.ts <input.md> [options]
  cat doc.md | node src/cli.ts - -o doc.pdf

Options
  -o, --output <file>     Output path (default: input with .pdf extension, "-" for stdout)
  -s, --size <name|WxH>   Page size: a3 a4 a5 letter legal tabloid, or 210mmx297mm (default: a4)
  -l, --landscape         Swap page width and height
  -m, --margin <len>      Margins; 1, 2 or 4 values, CSS order (default: 20mm)
      --font-size <len>   Base body font size (default: 11pt)
      --line-height <n>   Line height multiplier (default: 1.45)
      --title <text>      Document title (default: first level-1 heading)
      --author <text>     Document author metadata
      --subject <text>    Document subject metadata
      --no-page-numbers   Omit the page footer
      --no-compress       Write uncompressed streams (useful for inspecting the PDF)
  -h, --help              Show this help

Lengths accept pt (default), px, mm, cm and in — e.g. 18, 12pt, 15mm, 0.75in.
`;

function fail(message: string): never {
  process.stderr.write(`md-to-pdf: ${message}\n`);
  process.exit(1);
}

function parseLength(value: string, what: string): number {
  const match = /^(-?\d*\.?\d+)(pt|px|mm|cm|in)?$/i.exec(value.trim());
  if (match === null) fail(`invalid length for ${what}: ${value}`);
  const amount = Number.parseFloat(match[1]);
  switch ((match[2] ?? 'pt').toLowerCase()) {
    case 'mm': return (amount * 72) / 25.4;
    case 'cm': return (amount * 72) / 2.54;
    case 'in': return amount * 72;
    case 'px': return amount * 0.75;
    default: return amount;
  }
}

function parseMargins(value: string): [number, number, number, number] {
  const parts = value.trim().split(/[\s,]+/).map((part) => parseLength(part, 'margin'));
  switch (parts.length) {
    case 1: return [parts[0], parts[0], parts[0], parts[0]];
    case 2: return [parts[0], parts[1], parts[0], parts[1]];
    case 3: return [parts[0], parts[1], parts[2], parts[1]];
    case 4: return [parts[0], parts[1], parts[2], parts[3]];
    default: return fail(`expected 1 to 4 margin values, got ${parts.length}`);
  }
}

function parsePageSize(value: string): [number, number] {
  const named = PAGE_SIZES[value.trim().toLowerCase()];
  if (named !== undefined) return named;
  const custom = /^([^x]+)x(.+)$/i.exec(value.trim());
  if (custom === null) {
    fail(`unknown page size "${value}" (try ${Object.keys(PAGE_SIZES).join(', ')} or 210mmx297mm)`);
  }
  return [parseLength(custom[1], 'page width'), parseLength(custom[2], 'page height')];
}

interface Args {
  input: string | null;
  output: string | null;
  size: [number, number];
  landscape: boolean;
  margins: [number, number, number, number];
  fontSize: number;
  lineHeight: number;
  title: string | null;
  author: string | null;
  subject: string | null;
  pageNumbers: boolean;
  compress: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: null,
    output: null,
    size: PAGE_SIZES.a4,
    landscape: false,
    margins: parseMargins('20mm'),
    fontSize: 11,
    lineHeight: 1.45,
    title: null,
    author: null,
    subject: null,
    pageNumbers: true,
    compress: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} requires a value`);
      return value;
    };

    switch (arg) {
      case '-h': case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
      case '-o': case '--output': args.output = next(); break;
      case '-s': case '--size': args.size = parsePageSize(next()); break;
      case '-l': case '--landscape': args.landscape = true; break;
      case '-m': case '--margin': args.margins = parseMargins(next()); break;
      case '--font-size': args.fontSize = parseLength(next(), 'font size'); break;
      case '--line-height': args.lineHeight = Number.parseFloat(next()); break;
      case '--title': args.title = next(); break;
      case '--author': args.author = next(); break;
      case '--subject': args.subject = next(); break;
      case '--no-page-numbers': args.pageNumbers = false; break;
      case '--no-compress': args.compress = false; break;
      default:
        if (arg !== '-' && arg.startsWith('-')) fail(`unknown option ${arg}`);
        if (args.input !== null) fail(`unexpected extra argument ${arg}`);
        args.input = arg;
    }
  }

  if (!Number.isFinite(args.lineHeight) || args.lineHeight <= 0) fail('--line-height must be a positive number');
  if (args.fontSize <= 0) fail('--font-size must be positive');
  return args;
}

function firstHeading(blocks: Block[]): string | null {
  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 1) {
      const text = plainText(block.children).trim();
      if (text !== '') return text;
    }
  }
  return null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.input === null) {
    process.stdout.write(USAGE);
    process.exit(1);
  }

  const fromStdin = args.input === '-';
  const source = fromStdin
    ? readFileSync(0, 'utf8')
    : (() => {
        try {
          return readFileSync(resolve(args.input!), 'utf8');
        } catch (error) {
          return fail(`cannot read ${args.input}: ${(error as Error).message}`);
        }
      })();

  const document = parseMarkdown(source);
  const [width, height] = args.landscape ? [args.size[1], args.size[0]] : args.size;
  const [top, right, bottom, left] = args.margins;

  if (left + right >= width || top + bottom >= height) fail('margins leave no room for content');

  const options: RenderOptions = {
    pageWidth: width,
    pageHeight: height,
    marginTop: top,
    marginRight: right,
    marginBottom: bottom,
    marginLeft: left,
    fontSize: args.fontSize,
    lineHeight: args.lineHeight,
    pageNumbers: args.pageNumbers,
    title: args.title ?? firstHeading(document.blocks),
    author: args.author,
    subject: args.subject,
    baseDir: fromStdin ? process.cwd() : dirname(resolve(args.input!)),
    compress: args.compress,
    now: new Date(),
    theme: DEFAULT_THEME,
  };

  const { bytes, pages } = renderPdf(document, options);

  const output =
    args.output ??
    (fromStdin ? '-' : resolve(dirname(resolve(args.input)), `${basename(args.input, extname(args.input))}.pdf`));

  if (output === '-') {
    process.stdout.write(bytes);
    return;
  }

  writeFileSync(output, bytes);
  process.stderr.write(
    `${output} — ${pages} page${pages === 1 ? '' : 's'}, ${(bytes.length / 1024).toFixed(1)} KB\n`,
  );
}

main();
