# md-to-pdf

Converts Markdown to PDF with **no dependencies at all** — no headless browser, no
PDF library, no Markdown library, no build step. `src/` is TypeScript that Node 24
runs directly via its built-in type stripping.

```bash
node src/cli.ts README.md -o readme.pdf
cat notes.md | node src/cli.ts - -o - > notes.pdf
```

Use the bundled Node version with `nvm use` (see `.nvmrc`).

## How it works

Three layers, each independent:

| File | Responsibility |
|:--|:--|
| `src/markdown/` | Markdown → AST. `block.ts` scans lines into blocks, `inline.ts` tokenizes spans and resolves emphasis with a delimiter stack. |
| `src/render.ts` | AST → laid-out pages. Word wrapping, page breaks, tables, decorations, outline entries. |
| `src/pdf.ts` | Pages → PDF bytes. Indirect objects, Flate-compressed streams, a classic xref table. |
| `src/fonts.ts` | Base-14 font metrics and WinAnsi encoding, so text advances match what the viewer will do. |
| `src/images.ts` | PNG and JPEG → PDF image XObjects, using only `node:zlib`. |

The whole thing avoids embedding fonts by using the 14 typefaces every PDF reader is
required to provide (Helvetica, Courier, ZapfDingbats). That is why the output of a
long document is measured in kilobytes rather than megabytes.

## Options

```
-o, --output <file>     Output path (default: input with .pdf; "-" for stdout)
-s, --size <name|WxH>   a3 a4 a5 letter legal tabloid, or 210mmx297mm (default: a4)
-l, --landscape         Swap width and height
-m, --margin <len>      1, 2 or 4 values in CSS order (default: 20mm)
    --font-size <len>   Base body size (default: 11pt)
    --line-height <n>   Line height multiplier (default: 1.45)
    --title <text>      Document title; defaults to the first level-1 heading
    --author <text>     Author metadata
    --subject <text>    Subject metadata
    --no-page-numbers   Drop the footer
    --no-compress       Leave streams uncompressed, to read the PDF source
-h, --help              Usage
```

Lengths accept `pt` (default), `px` (at 96 dpi), `mm`, `cm` and `in`.

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

## Tests

```bash
npm test          # 39 tests, node:test, no dependencies
```

They cover the parser against known-correct CommonMark results, CLI behaviour, and
PDF invariants — including walking the xref table to confirm every offset points at
its own object header.

`npm run typecheck` additionally needs `npm i -D typescript @types/node`; the source
is clean under `strict` and `erasableSyntaxOnly`.
