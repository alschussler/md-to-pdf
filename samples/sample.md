![Github pipes](github-pipes.png)

# md-to-pdf

A **zero-dependency** Markdown to PDF converter written in _TypeScript_ and executed
directly by Node 24 — no build step, no bundler, no `node_modules`.

## Why bother?

Most Markdown-to-PDF tools ship a headless browser. This one writes the PDF byte
stream by hand and uses the 14 fonts that every PDF reader already has, so the whole
thing is about 2,000 lines of ~~JavaScript~~ TypeScript and starts in milliseconds.

### Inline formatting

Regular, **bold**, _italic_, **_bold italic_**, `inline code`, ~~struck through~~,
and a [link to the spec](https://spec.commonmark.org/ "CommonMark"). Autolinks such as
<https://nodejs.org> work too, as do entities (&copy; &mdash; &hellip;), em—dashes,
"smart quotes", and escaped \*asterisks\*.

Hard breaks work:  
this line follows a two-space break \
and this one follows a backslash break.

## Lists

1. Ordered items
2. …with nested content
   - unordered child
   - another child
     1. and a third level
3. Back to the top level

- [x] Task lists render real checkboxes
- [ ] Unchecked items too
- [x] Even nested ones:
  - [ ] like this

Loose lists get extra breathing room:

- First paragraph of the item.

  A second paragraph inside the same item.

- Another item.

## Code

Fenced blocks keep their whitespace and wrap long lines instead of clipping them:

```typescript
export function measure(text: string, font: FontKey, size: number): number {
  const widths = METRICS[font].widths;
  if (widths === null) return encodeWinAnsi(text).length * 0.6 * size;
  return (
    ([...encodeWinAnsi(text)].reduce(
      (total, byte) => total + (widths[byte - 32] || 556),
      0,
    ) /
      1000) *
    size
  );
}
```

    Indented code blocks work as well.
    They just need four spaces.

## Blockquotes

> Quotes can hold **any** block content, including lists:
>
> 1. like this one
> 2. and this one
>
> > …and they nest.

## Tables

| Feature   | Status |                                 Notes |
| :-------- | :----: | ------------------------------------: |
| Headings  |   ✔    |       Six levels, PDF outline entries |
| Tables    |   ✔    | Alignment, wrapping, repeated headers |
| Images    |   ✔    |                    Local PNG and JPEG |
| Footnotes |   ✘    |                         Not supported |

## Reference links

Definitions can appear anywhere and be [used][spec] before they are declared.

[spec]: https://spec.commonmark.org/0.31.2/ "CommonMark 0.31.2"

---

Long paragraph to force a page break and prove that content flows: Lorem ipsum dolor
sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et
dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco
laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in
reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.
Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt
mollit anim id est laborum.
