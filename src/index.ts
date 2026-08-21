#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { parseCliArgs } from "./cli.ts";
import { parseMarkdown } from "./markdown/block.ts";
import { plainText } from "./markdown/inline.ts";
import { DEFAULT_THEME, renderPdf } from "./render.ts";
import { log } from "./logger.ts";
import type { Block } from "./markdown/types.ts";
import type { CliOptions } from "./types.ts";
import type { RenderOptions } from "./render.ts";

// ─── Input ───────────────────────────────────────────────────────────────────

function readSource(input: string): string {
  if (input === "-") {
    return readFileSync(0, "utf8");
  }
  try {
    return readFileSync(resolve(input), "utf8");
  } catch (err: any) {
    throw new Error(`Cannot read ${input}: ${err.message}`);
  }
}

function firstHeading(blocks: Block[]): string | undefined {
  for (const block of blocks) {
    if (block.type === "heading" && block.level === 1) {
      const text = plainText(block.children).trim();
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function toRenderOptions(options: CliOptions, blocks: Block[]): RenderOptions {
  const [top, right, bottom, left] = options.margins;
  return {
    pageWidth: options.pageWidth,
    pageHeight: options.pageHeight,
    marginTop: top,
    marginRight: right,
    marginBottom: bottom,
    marginLeft: left,
    fontSize: options.fontSize,
    lineHeight: options.lineHeight,
    pageNumbers: options.pageNumbers,
    title: options.title ?? firstHeading(blocks) ?? null,
    author: options.author ?? null,
    subject: options.subject ?? null,
    baseDir: options.input === "-" ? process.cwd() : dirname(resolve(options.input)),
    compress: options.compress,
    now: new Date(),
    theme: DEFAULT_THEME,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv);
  } catch (err: any) {
    log.error(`Error: ${err.message}`);
    console.error("Run with --help for usage information.");
    process.exit(1);
  }

  let source: string;
  try {
    source = readSource(options.input);
  } catch (err: any) {
    log.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const document = parseMarkdown(source);
  const { bytes, pages } = renderPdf(document, toRenderOptions(options, document.blocks));

  // Writing to stdout must stay clean: the PDF is the only thing on it.
  if (options.output === "-") {
    process.stdout.write(bytes);
    return;
  }

  try {
    writeFileSync(options.output, bytes);
  } catch (err: any) {
    log.error(`Error: cannot write ${options.output}: ${err.message}`);
    process.exit(1);
  }

  log.success(`✓  ${options.output}`);
  log.dim(`   ${pages} page${pages === 1 ? "" : "s"}, ${(bytes.length / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  log.error(`\nUnexpected error: ${err.message}`);
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});
