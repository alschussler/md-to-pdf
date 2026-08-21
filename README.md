# md-to-pdf

Converts Markdown to PDF with **no runtime dependencies** — no headless browser, no
PDF library, no Markdown library, no build step. `src/` is TypeScript that Node 24
runs directly via its built-in type stripping.

```bash
node src/index.ts README.md -o readme.pdf
cat notes.md | node src/index.ts - -o - > notes.pdf
```

Node 24 or newer is required — it is what strips the types. Run `nvm use` to pick up
the pinned version from `.nvmrc`.

## How it works

Each layer is independent:

| File | Responsibility |
|:--|:--|
| `src/index.ts` | Entry point: reads input, wires options into the renderer, writes the PDF. |
| `src/cli.ts` | Argument parsing via `node:util` `parseArgs`, plus the usage text. |
| `src/markdown/` | Markdown → AST. `block.ts` scans lines into blocks, `inline.ts` tokenizes spans and resolves emphasis with a delimiter stack. |
| `src/render.ts` | AST → laid-out pages. Word wrapping, page breaks, tables, decorations, outline entries. |
| `src/pdf.ts` | Pages → PDF bytes. Indirect objects, Flate-compressed streams, a classic xref table. |
| `src/fonts.ts` | Base-14 font metrics and WinAnsi encoding, so text advances match what the viewer will do. |
| `src/images.ts` | PNG and JPEG → PDF image XObjects, using only `node:zlib`. |
| `src/utils.ts` | Length, margin and page-size parsing. |
| `src/logger.ts` | TTY-aware coloured output. |

The whole thing avoids embedding fonts by using the 14 typefaces every PDF reader is
required to provide (Helvetica, Courier, ZapfDingbats). That is why the output of a
long document is measured in kilobytes rather than megabytes.

## Options

```
md-to-pdf <input.md> [options]
md-to-pdf - -o out.pdf            (read Markdown from stdin)

  -o, --output           Output path, or "-" for stdout (default: input with .pdf)
  -s, --size             a3, a4, a5, letter, legal, tabloid, or 210mmx297mm
  -l, --landscape        Swap the page width and height
  -m, --margin           1, 2 or 4 lengths in CSS order (default: 20mm)
      --font-size        Base body font size (default: 11pt)
      --line-height      Line height multiplier (default: 1.45)
      --title            Document title (default: the first level-1 heading)
      --author           Document author metadata
      --subject          Document subject metadata
      --no-page-numbers  Omit the page-number footer
      --no-compress      Leave streams uncompressed, to read the generated PDF
  -h, --help             Show this help message
```

Lengths accept `pt` (the default), `px` (at 96 dpi), `mm`, `cm` and `in`.

## Markdown support

Headings (ATX and Setext) · paragraphs · `**bold**` · `*italic*` · `***both***` ·
`` `code` `` · `~~strikethrough~~` · links, reference links, autolinks and bare URLs ·
images · fenced and indented code blocks · blockquotes (nested) · ordered, unordered
and nested lists (tight and loose) · task lists with drawn checkboxes · GFM tables
with alignment, wrapping and headers repeated across pages · thematic breaks ·
backslash escapes · HTML entities · hard breaks.

PDFs come out with a clickable outline built from the headings, live link
annotations, and document metadata.

### Deliberate limitations

- **Text is WinAnsi (Latin-1).** Arrows, box drawing and a few symbols are
  transliterated (`→` → `->`), check marks are drawn from ZapfDingbats, and accents
  outside Latin-1 are stripped to their base letter. CJK and emoji become `?` —
  rendering them would mean embedding a font, which is the one thing this tool
  refuses to carry.
- **Images must be local PNG or JPEG.** Nothing is fetched over the network.
  Interlaced PNGs and other formats fall back to their alt text.
- **Inline HTML is dropped**, not rendered; `<br>` becomes a line break.
- **No syntax highlighting or footnotes.**

## Development

```bash
npm install       # @types/node and typescript, for typechecking only
npm test          # 43 tests, node:test, no test framework
npm run typecheck # tsc --noEmit over src/ and test/
npm run sample    # regenerate samples/sample.pdf
```

Tests cover the parser against known-correct CommonMark results, CLI behaviour, and
PDF invariants — including walking the xref table to confirm every offset points at
its own object header, and walking the outline tree to confirm its hierarchy,
destinations and `Count` fields.

Running the tool needs nothing installed: `node src/index.ts` works on a bare
checkout. There is no build step — `bin` points straight at the TypeScript entry
point and Node strips the types, so the only reason to `npm install` is to run the
typechecker.
