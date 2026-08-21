import { parseArgs } from "node:util";
import { basename, dirname, extname, resolve } from "node:path";

import { parseLength, parseMargins, parsePageSize } from "./utils.ts";
import type { CliOptions } from "./types.ts";

type CliArgDescription = {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  default?: string | boolean | string[] | boolean[];
  description: string;
};

type CliArgs = Record<string, CliArgDescription>;

const ARGS_OPTIONS = {
  output: {
    type: "string" as const,
    short: "o",
    description:
      'Output path, or "-" for stdout (default: the input path with a .pdf extension)',
  },
  size: {
    type: "string" as const,
    short: "s",
    default: "a4",
    description:
      "Page size: a3, a4, a5, letter, legal, tabloid, or an explicit size like 210mmx297mm",
  },
  landscape: {
    type: "boolean" as const,
    short: "l",
    default: false,
    description: "Swap the page width and height",
  },
  margin: {
    type: "string" as const,
    short: "m",
    default: "20mm",
    description: "Page margins: 1, 2 or 4 lengths in CSS order",
  },
  "font-size": {
    type: "string" as const,
    default: "11pt",
    description: "Base body font size",
  },
  "line-height": {
    type: "string" as const,
    default: "1.45",
    description: "Line height as a multiple of the font size",
  },
  title: {
    type: "string" as const,
    description: "Document title (default: the first level-1 heading)",
  },
  author: {
    type: "string" as const,
    description: "Document author metadata",
  },
  subject: {
    type: "string" as const,
    description: "Document subject metadata",
  },
  "no-page-numbers": {
    type: "boolean" as const,
    default: false,
    description: "Omit the page-number footer",
  },
  "no-compress": {
    type: "boolean" as const,
    default: false,
    description: "Leave PDF streams uncompressed, to read the generated PDF",
  },
  help: {
    type: "boolean" as const,
    short: "h",
    default: false,
    description: "Show this help message",
  },
} satisfies CliArgs;

export function parseCliArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const { values, positionals } = parseArgs({
    args,
    options: ARGS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (positionals.length === 0) {
    throw new Error('An input Markdown file is required (use "-" to read from stdin)');
  }
  if (positionals.length > 1) {
    throw new Error(
      `Expected a single input file, got ${positionals.length}: ${positionals.join(", ")}`,
    );
  }

  const input = positionals[0];
  const [width, height] = parsePageSize(values.size, "--size");
  const [pageWidth, pageHeight] = values.landscape ? [height, width] : [width, height];
  const margins = parseMargins(values.margin, "--margin");
  const [top, right, bottom, left] = margins;

  if (left + right >= pageWidth || top + bottom >= pageHeight) {
    throw new Error(
      `--margin ${values.margin} leaves no room for content on a ` +
      `${pageWidth.toFixed(0)}x${pageHeight.toFixed(0)}pt page`,
    );
  }

  const fontSize = parseLength(values["font-size"], "--font-size");
  if (fontSize <= 0) {
    throw new Error(`--font-size requires a positive length, got: ${values["font-size"]}`);
  }

  const lineHeight = parseFloat(values["line-height"]);
  if (isNaN(lineHeight) || lineHeight <= 0) {
    throw new Error(
      `--line-height requires a positive number, got: ${values["line-height"]}`,
    );
  }

  return {
    input,
    output: values.output ?? defaultOutput(input),
    pageWidth,
    pageHeight,
    margins,
    fontSize,
    lineHeight,
    pageNumbers: !values["no-page-numbers"],
    compress: !values["no-compress"],
    title: values.title,
    author: values.author,
    subject: values.subject,
  };
}

function defaultOutput(input: string): string {
  if (input === "-") {
    return "-";
  }
  const absolute = resolve(input);
  return resolve(dirname(absolute), `${basename(absolute, extname(absolute))}.pdf`);
}

export function printUsage(): void {
  console.log("");
  console.log("md-to-pdf — Convert Markdown to PDF with no dependencies");
  console.log("");
  console.log("Usage:");
  console.log("  md-to-pdf <input.md> [options]");
  console.log("  md-to-pdf - -o out.pdf            (read Markdown from stdin)");
  console.log("");
  console.log("Options:");
  for (const [key, value] of Object.entries(ARGS_OPTIONS) as [
    string,
    CliArgDescription,
  ][]) {
    const flag = `${value.short ? `-${value.short}, ` : "    "}--${key}`;
    console.log(`  ${flag.padEnd(21)}  ${value.description}`);
  }
  console.log("");
  console.log("Lengths accept pt (the default), px at 96 dpi, mm, cm and in.");
  console.log("");
  console.log("Examples:");
  console.log("  md-to-pdf README.md");
  console.log("  md-to-pdf notes.md -o notes.pdf -s letter -m 1in");
  console.log("  md-to-pdf report.md --font-size 12pt --line-height 1.6 --title Report");
  console.log("  md-to-pdf slides.md -s a4 -l --no-page-numbers");
  console.log("  cat notes.md | md-to-pdf - -o - > notes.pdf");
  console.log("");
}
