import { resolve, dirname } from 'node:path';
import type { Align, Block, Document, Inline } from './markdown/types.ts';
import { plainText } from './markdown/inline.ts';
import { boldOf, italicOf, measure, baseFontName, splitSymbols, usesWinAnsi, FONT_KEYS } from './fonts.ts';
import type { FontKey } from './fonts.ts';
import { PdfWriter, name, pdfString, pdfDate } from './pdf.ts';
import type { PdfDict, PdfRef, PdfValue } from './pdf.ts';
import { loadImage } from './images.ts';
import type { EmbeddedImage } from './images.ts';

export type RGB = readonly [number, number, number];

export interface Theme {
  text: RGB;
  heading: RGB;
  muted: RGB;
  link: RGB;
  accent: RGB;
  codeText: RGB;
  codeBackground: RGB;
  codeBorder: RGB;
  rule: RGB;
  quoteBar: RGB;
  quoteText: RGB;
  tableBorder: RGB;
  tableHeader: RGB;
  headingScale: readonly number[];
}

export const DEFAULT_THEME: Theme = {
  text: [0.12, 0.14, 0.16],
  heading: [0.05, 0.07, 0.09],
  muted: [0.42, 0.45, 0.49],
  link: [0.03, 0.41, 0.85],
  accent: [0.13, 0.45, 0.28],
  codeText: [0.16, 0.18, 0.21],
  codeBackground: [0.965, 0.973, 0.98],
  codeBorder: [0.87, 0.89, 0.91],
  rule: [0.85, 0.87, 0.89],
  quoteBar: [0.78, 0.81, 0.84],
  quoteText: [0.35, 0.38, 0.42],
  tableBorder: [0.82, 0.85, 0.88],
  tableHeader: [0.96, 0.97, 0.98],
  headingScale: [2.0, 1.55, 1.28, 1.12, 1.0, 0.92],
};

export interface RenderOptions {
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  fontSize: number;
  lineHeight: number;
  pageNumbers: boolean;
  title: string | null;
  author: string | null;
  subject: string | null;
  baseDir: string;
  compress: boolean;
  now: Date;
  theme: Theme;
}

const ASCENT = 0.75;
const IMAGE_DPI = 96;

interface Style {
  font: FontKey;
  size: number;
  color: RGB;
  link: string | null;
  underline: boolean;
  strike: boolean;
  codeSpan: boolean;
}

interface Atom {
  text: string;
  width: number;
  style: Style;
  isSpace: boolean;
  hardBreak: boolean;
}

interface Line {
  atoms: Atom[];
  width: number;
  maxSize: number;
  height: number;
}

interface Annotation {
  rect: [number, number, number, number];
  uri: string;
}

interface Page {
  background: string[];
  body: string[];
  annotations: Annotation[];
  images: Set<string>;
}

interface BoxSegment {
  page: number;
  top: number;
  bottom: number;
}

interface OutlineEntry {
  level: number;
  title: string;
  page: number;
  y: number;
}

function newPage(): Page {
  return { background: [], body: [], annotations: [], images: new Set() };
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function rgb(color: RGB): string {
  return `${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])}`;
}

class Layout {
  private readonly options: RenderOptions;
  private readonly theme: Theme;
  private readonly pages: Page[] = [];
  private readonly boxes: BoxSegment[][] = [];
  private readonly imageNames = new Map<string, string>();
  private readonly imageData = new Map<string, EmbeddedImage>();
  readonly outline: OutlineEntry[] = [];

  private y = 0;
  private indentLeft = 0;
  private indentRight = 0;
  private textColor: RGB | null = null;

  constructor(options: RenderOptions) {
    this.options = options;
    this.theme = options.theme;
    this.pages.push(newPage());
    this.y = options.marginTop;
  }

  get allPages(): readonly Page[] {
    return this.pages;
  }

  get images(): ReadonlyMap<string, { resource: string; image: EmbeddedImage }> {
    const merged = new Map<string, { resource: string; image: EmbeddedImage }>();
    for (const [path, resource] of this.imageNames) {
      const image = this.imageData.get(path);
      if (image !== undefined) merged.set(path, { resource, image });
    }
    return merged;
  }

  private get page(): Page {
    return this.pages[this.pages.length - 1];
  }

  private get contentTop(): number {
    return this.options.marginTop;
  }

  private get contentBottom(): number {
    return this.options.pageHeight - this.options.marginBottom;
  }

  private get fullWidth(): number {
    return this.options.pageWidth - this.options.marginLeft - this.options.marginRight;
  }

  /** Deeply nested content stops indenting rather than sliding off the page. */
  private get minimumWidth(): number {
    return Math.min(this.fullWidth, this.options.fontSize * 6);
  }

  private get left(): number {
    const maxIndent = Math.max(0, this.fullWidth - this.indentRight - this.minimumWidth);
    return this.options.marginLeft + Math.min(this.indentLeft, maxIndent);
  }

  private get width(): number {
    const used = this.left - this.options.marginLeft + this.indentRight;
    return Math.max(this.minimumWidth, this.fullWidth - used);
  }

  private baseStyle(): Style {
    return {
      font: 'regular',
      size: this.options.fontSize,
      color: this.textColor ?? this.theme.text,
      link: null,
      underline: false,
      strike: false,
      codeSpan: false,
    };
  }

  private pdfY(top: number): number {
    return this.options.pageHeight - top;
  }

  private breakPage(): void {
    for (const box of this.boxes) box[box.length - 1].bottom = this.contentBottom;
    this.pages.push(newPage());
    this.y = this.contentTop;
    for (const box of this.boxes) box.push({ page: this.pages.length - 1, top: this.y, bottom: this.y });
  }

  private ensureSpace(height: number): void {
    if (this.y + height <= this.contentBottom) return;
    if (this.y <= this.contentTop + 0.01) return;
    this.breakPage();
  }

  private openBox(): BoxSegment[] {
    const box: BoxSegment[] = [{ page: this.pages.length - 1, top: this.y, bottom: this.y }];
    this.boxes.push(box);
    return box;
  }

  private closeBox(box: BoxSegment[]): BoxSegment[] {
    box[box.length - 1].bottom = this.y;
    const index = this.boxes.indexOf(box);
    if (index >= 0) this.boxes.splice(index, 1);
    return box.filter((segment) => segment.bottom > segment.top);
  }

  private rect(
    pageIndex: number,
    x: number,
    top: number,
    width: number,
    height: number,
    fill: RGB | null,
    stroke: RGB | null = null,
    lineWidth = 0.6,
  ): void {
    if (height <= 0 || width <= 0) return;
    const ops: string[] = ['q'];
    if (fill !== null) ops.push(`${rgb(fill)} rg`);
    if (stroke !== null) ops.push(`${rgb(stroke)} RG`, `${fmt(lineWidth)} w`);
    ops.push(`${fmt(x)} ${fmt(this.pdfY(top + height))} ${fmt(width)} ${fmt(height)} re`);
    ops.push(fill !== null && stroke !== null ? 'B' : fill !== null ? 'f' : 'S');
    ops.push('Q');
    this.pages[pageIndex].background.push(ops.join('\n'));
  }

  private line(x0: number, top0: number, x1: number, top1: number, color: RGB, lineWidth: number): void {
    this.page.body.push(
      [
        'q',
        `${rgb(color)} RG`,
        `${fmt(lineWidth)} w`,
        `${fmt(x0)} ${fmt(this.pdfY(top0))} m`,
        `${fmt(x1)} ${fmt(this.pdfY(top1))} l`,
        'S',
        'Q',
      ].join('\n'),
    );
  }

  private atomize(nodes: Inline[], style: Style, out: Atom[]): void {
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          this.pushText(node.value, style, out);
          break;
        case 'code':
          this.pushText(node.value, {
            ...style,
            font: style.font === 'bold' || style.font === 'boldItalic' ? 'monoBold' : 'mono',
            size: style.size * 0.9,
            color: style.link === null ? this.theme.codeText : style.color,
            codeSpan: true,
          }, out);
          break;
        case 'strong':
          this.atomize(node.children, { ...style, font: boldOf(style.font) }, out);
          break;
        case 'em':
          this.atomize(node.children, { ...style, font: italicOf(style.font) }, out);
          break;
        case 'del':
          this.atomize(node.children, { ...style, strike: true }, out);
          break;
        case 'link':
          this.atomize(node.children, {
            ...style,
            color: this.theme.link,
            link: node.href,
            underline: true,
          }, out);
          break;
        case 'image':
          this.pushText(node.alt === '' ? '[image]' : node.alt, {
            ...style,
            font: italicOf(style.font),
            color: this.theme.muted,
          }, out);
          break;
        case 'break':
          out.push({ text: '', width: 0, style, isSpace: false, hardBreak: true });
          break;
      }
    }
  }

  private pushText(value: string, style: Style, out: Atom[]): void {
    if (value === '') return;
    for (const segment of splitSymbols(value)) {
      const segmentStyle: Style = segment.symbol ? { ...style, font: 'symbol' } : style;
      for (const part of segment.text.split(/( +)/)) {
        if (part === '') continue;
        out.push({
          text: part,
          width: measure(part, segmentStyle.font, segmentStyle.size),
          style: segmentStyle,
          isSpace: part.trim() === '',
          hardBreak: false,
        });
      }
    }
  }

  private splitWide(atom: Atom, maxWidth: number): Atom[] {
    const chunks: Atom[] = [];
    let current = '';
    for (const ch of atom.text) {
      const candidate = current + ch;
      if (current !== '' && measure(candidate, atom.style.font, atom.style.size) > maxWidth) {
        chunks.push({ ...atom, text: current, width: measure(current, atom.style.font, atom.style.size) });
        current = ch;
        continue;
      }
      current = candidate;
    }
    if (current !== '') {
      chunks.push({ ...atom, text: current, width: measure(current, atom.style.font, atom.style.size) });
    }
    return chunks;
  }

  private makeLine(atoms: Atom[], width: number, fallbackSize: number): Line {
    let maxSize = fallbackSize;
    for (const atom of atoms) maxSize = Math.max(maxSize, atom.style.size);
    return { atoms, width, maxSize, height: maxSize * this.options.lineHeight };
  }

  private wrap(atoms: Atom[], maxWidth: number, fallbackSize: number): Line[] {
    const expanded = atoms.flatMap((atom) =>
      !atom.isSpace && !atom.hardBreak && atom.width > maxWidth ? this.splitWide(atom, maxWidth) : [atom],
    );

    const lines: Line[] = [];
    let current: Atom[] = [];
    let width = 0;

    const flush = (): void => {
      while (current.length > 0 && current[current.length - 1].isSpace) width -= current.pop()!.width;
      lines.push(this.makeLine(current, width, fallbackSize));
      current = [];
      width = 0;
    };

    for (const atom of expanded) {
      if (atom.hardBreak) {
        flush();
        continue;
      }
      if (atom.isSpace && current.length === 0) continue;
      if (current.length > 0 && width + atom.width > maxWidth + 0.01) {
        flush();
        if (atom.isSpace) continue;
      }
      current.push(atom);
      width += atom.width;
    }
    if (current.length > 0 || lines.length === 0) flush();
    return lines;
  }

  private drawLine(line: Line, x: number, top: number, boxWidth: number, align: Align): void {
    if (line.atoms.length === 0) return;

    const offset = align === 'center' ? (boxWidth - line.width) / 2 : align === 'right' ? boxWidth - line.width : 0;
    const leading = (line.height - line.maxSize) / 2;
    const baseline = this.pdfY(top + leading + line.maxSize * ASCENT);
    let cursor = x + Math.max(0, offset);

    const text: string[] = ['BT', `1 0 0 1 ${fmt(cursor)} ${fmt(baseline)} Tm`];
    let currentFont: FontKey | null = null;
    let currentSize = 0;
    let currentColor = '';

    for (const atom of line.atoms) {
      const { style } = atom;
      if (style.codeSpan) {
        const pad = style.size * 0.16;
        this.rect(
          this.pages.length - 1,
          cursor - (atom.isSpace ? 0 : pad),
          top + leading - style.size * 0.12,
          atom.width + (atom.isSpace ? 0 : pad * 2),
          style.size * 1.22,
          this.theme.codeBackground,
        );
      }

      if (style.font !== currentFont || style.size !== currentSize) {
        text.push(`/${fontResource(style.font)} ${fmt(style.size)} Tf`);
        currentFont = style.font;
        currentSize = style.size;
      }
      const color = rgb(style.color);
      if (color !== currentColor) {
        text.push(`${color} rg`);
        currentColor = color;
      }
      text.push(`${pdfString(atom.text)} Tj`);
      cursor += atom.width;
    }
    text.push('ET');
    this.page.body.push(text.join('\n'));

    this.decorate(line, x + Math.max(0, offset), top, leading);
  }

  private decorate(line: Line, startX: number, top: number, leading: number): void {
    let cursor = startX;
    let run: { style: Style; from: number; to: number } | null = null;

    const flush = (): void => {
      if (run === null) return;
      const { style, from, to } = run;
      const baselineTop = top + leading + style.size * ASCENT;
      if (style.underline) {
        this.line(from, baselineTop + style.size * 0.11, to, baselineTop + style.size * 0.11, style.color, style.size * 0.055);
      }
      if (style.strike) {
        this.line(from, baselineTop - style.size * 0.24, to, baselineTop - style.size * 0.24, style.color, style.size * 0.06);
      }
      if (style.link !== null) {
        this.page.annotations.push({
          rect: [from, this.pdfY(top + leading + style.size * 1.05), to, this.pdfY(top + leading - style.size * 0.1)],
          uri: style.link,
        });
      }
      run = null;
    };

    for (const atom of line.atoms) {
      const decorated = atom.style.underline || atom.style.strike || atom.style.link !== null;
      const sameRun =
        run !== null &&
        run.style.link === atom.style.link &&
        run.style.underline === atom.style.underline &&
        run.style.strike === atom.style.strike &&
        run.style.size === atom.style.size;

      if (decorated && sameRun) run!.to = cursor + atom.width;
      else {
        flush();
        if (decorated) run = { style: atom.style, from: cursor, to: cursor + atom.width };
      }
      cursor += atom.width;
    }
    flush();
  }

  private emitLines(lines: Line[], align: Align = 'left'): void {
    for (const line of lines) {
      this.ensureSpace(line.height);
      this.drawLine(line, this.left, this.y, this.width, align);
      this.y += line.height;
    }
  }

  private topGap(block: Block, tight: boolean): number {
    const base = this.options.fontSize;
    switch (block.type) {
      case 'heading':
        return base * (block.level <= 2 ? 1.5 : 1.15);
      case 'paragraph':
        return tight ? base * 0.2 : base * 0.75;
      case 'codeBlock':
        return base * 0.8;
      case 'blockquote':
        return base * 0.85;
      case 'list':
        return tight ? base * 0.3 : base * 0.7;
      case 'table':
        return base * 0.9;
      case 'thematicBreak':
        return base * 1.1;
    }
  }

  private bottomGap(block: Block, tight: boolean): number {
    const base = this.options.fontSize;
    switch (block.type) {
      case 'heading':
        return base * 0.4;
      case 'paragraph':
        return tight ? base * 0.2 : base * 0.75;
      default:
        return this.topGap(block, tight);
    }
  }

  renderBlocks(blocks: Block[], tight = false): void {
    let previous: Block | null = null;
    for (const block of blocks) {
      if (previous !== null) {
        this.y += Math.max(this.bottomGap(previous, tight), this.topGap(block, tight));
      }
      this.renderBlock(block, tight);
      previous = block;
    }
  }

  private renderBlock(block: Block, tight: boolean): void {
    switch (block.type) {
      case 'heading':
        this.renderHeading(block.level, block.children);
        break;
      case 'paragraph':
        this.renderParagraph(block.children);
        break;
      case 'codeBlock':
        this.renderCodeBlock(block.value);
        break;
      case 'blockquote':
        this.renderBlockquote(block.children);
        break;
      case 'list':
        this.renderList(block);
        break;
      case 'thematicBreak':
        this.renderThematicBreak();
        break;
      case 'table':
        this.renderTable(block);
        break;
    }
  }

  private renderHeading(level: number, children: Inline[]): void {
    const size = this.options.fontSize * (this.theme.headingScale[level - 1] ?? 1);
    const style: Style = {
      ...this.baseStyle(),
      font: 'bold',
      size,
      color: this.theme.heading,
    };
    const atoms: Atom[] = [];
    this.atomize(children, style, atoms);
    const lines = this.wrap(atoms, this.width, size);

    const needed = lines[0].height + (level <= 3 ? this.options.fontSize * this.options.lineHeight : 0);
    this.ensureSpace(needed);

    this.outline.push({
      level,
      title: plainText(children).trim() || `Section ${this.outline.length + 1}`,
      page: this.pages.length - 1,
      y: this.pdfY(Math.max(this.contentTop, this.y - this.options.fontSize * 0.5)),
    });

    this.emitLines(lines);

    if (level <= 2) {
      this.y += size * 0.25;
      this.line(this.left, this.y, this.left + this.width, this.y, this.theme.rule, 0.7);
    }
  }

  private renderParagraph(children: Inline[]): void {
    const meaningful = children.filter((node) => !(node.type === 'text' && node.value.trim() === ''));
    if (meaningful.length === 1 && meaningful[0].type === 'image') {
      if (this.renderImage(meaningful[0])) return;
    }
    const atoms: Atom[] = [];
    this.atomize(children, this.baseStyle(), atoms);
    this.emitLines(this.wrap(atoms, this.width, this.options.fontSize));
  }

  private renderImage(node: Extract<Inline, { type: 'image' }>): boolean {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(node.src) && !node.src.startsWith('file:')) return false;
    const path = resolve(this.options.baseDir, decodeURI(node.src.replace(/^file:\/\//, '')));

    let image = this.imageData.get(path);
    if (image === undefined) {
      const loaded = loadImage(path);
      if (loaded === null) return false;
      image = loaded;
      this.imageData.set(path, image);
      this.imageNames.set(path, `Im${this.imageNames.size + 1}`);
    }

    const scale = 72 / IMAGE_DPI;
    const maxWidth = this.width;
    const maxHeight = this.contentBottom - this.contentTop;
    let width = image.width * scale;
    let height = image.height * scale;
    const factor = Math.min(1, maxWidth / width, maxHeight / height);
    width *= factor;
    height *= factor;

    this.ensureSpace(height);
    const resource = this.imageNames.get(path)!;
    this.page.images.add(resource);
    const x = this.left + (this.width - width) / 2;
    this.page.body.push(
      [
        'q',
        `${fmt(width)} 0 0 ${fmt(height)} ${fmt(x)} ${fmt(this.pdfY(this.y + height))} cm`,
        `/${resource} Do`,
        'Q',
      ].join('\n'),
    );
    this.y += height;

    if (node.title !== null && node.title !== '') {
      this.y += this.options.fontSize * 0.35;
      const caption: Atom[] = [];
      const size = this.options.fontSize * 0.85;
      this.atomize([{ type: 'text', value: node.title }], {
        ...this.baseStyle(),
        font: 'italic',
        size,
        color: this.theme.muted,
      }, caption);
      this.emitLines(this.wrap(caption, this.width, size), 'center');
    }
    return true;
  }

  private renderCodeBlock(value: string): void {
    const size = this.options.fontSize * 0.88;
    const style: Style = { ...this.baseStyle(), font: 'mono', size, color: this.theme.codeText };
    const padX = size * 0.7;
    const padY = size * 0.6;
    const lineHeight = size * 1.4;
    const available = this.width - padX * 2;

    const hang = Math.min(measure('  ', style.font, size), available / 4);
    const wrapped: { atom: Atom; indent: number }[] = [];

    for (const source of value.replace(/\n+$/, '').split('\n')) {
      let rest = source === '' ? ' ' : source;
      let indent = 0;
      for (;;) {
        const limit = Math.max(available - indent, size);
        const atom: Atom = {
          text: rest,
          width: measure(rest, style.font, size),
          style,
          isSpace: false,
          hardBreak: false,
        };
        if (atom.width <= limit) {
          wrapped.push({ atom, indent });
          break;
        }
        const chunks = this.splitWide(atom, limit);
        wrapped.push({ atom: chunks[0], indent });
        rest = chunks.slice(1).map((chunk) => chunk.text).join('');
        indent = hang;
      }
    }

    this.ensureSpace(Math.min(padY * 2 + lineHeight * wrapped.length, lineHeight * 3));
    const box = this.openBox();
    const boxLeft = this.left;
    const boxWidth = this.width;
    this.y += padY;

    for (const { atom, indent } of wrapped) {
      this.ensureSpace(lineHeight);
      const line = this.makeLine([atom], atom.width, size);
      this.drawLine({ ...line, height: lineHeight }, boxLeft + padX + indent, this.y, available - indent, 'left');
      this.y += lineHeight;
    }

    this.y += padY;
    for (const segment of this.closeBox(box)) {
      this.rect(
        segment.page,
        boxLeft,
        segment.top,
        boxWidth,
        segment.bottom - segment.top,
        this.theme.codeBackground,
        this.theme.codeBorder,
        0.6,
      );
    }
  }

  private renderBlockquote(children: Block[]): void {
    const barWidth = 3;
    const gap = this.options.fontSize * 0.7;
    const box = this.openBox();
    const barLeft = this.left;

    const previousColor = this.textColor;
    this.indentLeft += barWidth + gap;
    this.textColor = this.theme.quoteText;
    this.renderBlocks(children);
    this.textColor = previousColor;
    this.indentLeft -= barWidth + gap;

    for (const segment of this.closeBox(box)) {
      this.rect(segment.page, barLeft, segment.top, barWidth, segment.bottom - segment.top, this.theme.quoteBar);
    }
  }

  private renderList(block: Extract<Block, { type: 'list' }>): void {
    const size = this.options.fontSize;
    const markers = block.items.map((_, index) =>
      block.ordered ? `${block.start + index}.` : '•',
    );
    const widest = Math.max(...markers.map((marker) => measure(marker, 'regular', size)), size * 0.6);
    const indent = widest + size * 0.6;

    for (let index = 0; index < block.items.length; index++) {
      const item = block.items[index];
      if (index > 0) this.y += block.tight ? size * 0.25 : size * 0.6;

      this.ensureSpace(size * this.options.lineHeight);
      const markerPage = this.pages.length - 1;
      const markerTop = this.y;

      this.indentLeft += indent;
      if (item.children.length === 0) this.y += size * this.options.lineHeight;
      else this.renderBlocks(item.children, block.tight);
      this.indentLeft -= indent;

      const leading = (size * this.options.lineHeight - size) / 2;
      if (item.checked === null) {
        const marker = markers[index];
        const markerWidth = measure(marker, 'regular', size);
        const x = this.left + widest - markerWidth;
        this.pages[markerPage].body.push(
          [
            'BT',
            `/${fontResource('regular')} ${fmt(size)} Tf`,
            `${rgb(this.textColor ?? this.theme.text)} rg`,
            `1 0 0 1 ${fmt(x)} ${fmt(this.pdfY(markerTop + leading + size * ASCENT))} Tm`,
            `${pdfString(marker)} Tj`,
            'ET',
          ].join('\n'),
        );
      } else {
        this.drawCheckbox(markerPage, this.left, markerTop + leading + size * 0.08, size * 0.82, item.checked);
      }
    }
  }

  private drawCheckbox(pageIndex: number, x: number, top: number, boxSize: number, checked: boolean): void {
    const bottom = this.pdfY(top + boxSize);
    const ops: string[] = ['q', `${fmt(0.7)} w`];
    if (checked) {
      ops.push(`${rgb(this.theme.accent)} rg`, `${rgb(this.theme.accent)} RG`);
    } else {
      ops.push('1 1 1 rg', `${rgb(this.theme.quoteBar)} RG`);
    }
    ops.push(`${fmt(x)} ${fmt(bottom)} ${fmt(boxSize)} ${fmt(boxSize)} re`, 'B');
    if (checked) {
      ops.push(
        '1 1 1 RG',
        `${fmt(boxSize * 0.16)} w`,
        '1 J',
        '1 j',
        `${fmt(x + boxSize * 0.22)} ${fmt(bottom + boxSize * 0.52)} m`,
        `${fmt(x + boxSize * 0.42)} ${fmt(bottom + boxSize * 0.28)} l`,
        `${fmt(x + boxSize * 0.8)} ${fmt(bottom + boxSize * 0.72)} l`,
        'S',
      );
    }
    ops.push('Q');
    this.pages[pageIndex].body.push(ops.join('\n'));
  }

  private renderThematicBreak(): void {
    this.ensureSpace(2);
    this.line(this.left, this.y, this.left + this.width, this.y, this.theme.rule, 0.8);
    this.y += 2;
  }

  private renderTable(block: Extract<Block, { type: 'table' }>): void {
    const size = this.options.fontSize * 0.94;
    const columns = block.header.length;
    if (columns === 0) return;
    const padding = Math.min(size * 0.5, this.width / (columns * 4));

    const headerStyle: Style = { ...this.baseStyle(), font: 'bold', size, color: this.theme.heading };
    const bodyStyle: Style = { ...this.baseStyle(), size };

    const cellAtoms = (cell: Inline[], style: Style): Atom[] => {
      const atoms: Atom[] = [];
      this.atomize(cell, style, atoms);
      return atoms;
    };

    const headerCells = block.header.map((cell) => cellAtoms(cell, headerStyle));
    const bodyCells = block.rows.map((row) => row.map((cell) => cellAtoms(cell, bodyStyle)));

    const natural = new Array<number>(columns).fill(0);
    const minimum = new Array<number>(columns).fill(0);
    const account = (atoms: Atom[], column: number): void => {
      const total = atoms.reduce((sum, atom) => sum + atom.width, 0);
      natural[column] = Math.max(natural[column], total);
      for (const atom of atoms) if (!atom.isSpace) minimum[column] = Math.max(minimum[column], atom.width);
    };
    headerCells.forEach(account);
    for (const row of bodyCells) row.forEach(account);

    const available = this.width - padding * 2 * columns;
    const contentWidths = distributeWidths(minimum, natural, available);

    const columnWidths = contentWidths.map((w) => w + padding * 2);
    const align = (index: number): Align => block.align[index] ?? 'left';

    const rowLines = (cells: Atom[][]): Line[][] =>
      cells.map((atoms, index) => this.wrap(atoms, contentWidths[index], size));
    const rowHeight = (lines: Line[][]): number =>
      Math.max(size * this.options.lineHeight, ...lines.map((cell) => cell.reduce((sum, l) => sum + l.height, 0))) +
      padding * 2;

    const headerLines = rowLines(headerCells);
    const headerHeight = rowHeight(headerLines);

    const drawRow = (lines: Line[][], height: number, isHeader: boolean): void => {
      const top = this.y;
      if (isHeader) {
        this.rect(this.pages.length - 1, this.left, top, this.width, height, this.theme.tableHeader);
      }
      let x = this.left;
      for (let column = 0; column < columns; column++) {
        let cellY = top + padding;
        for (const line of lines[column]) {
          this.drawLine(line, x + padding, cellY, contentWidths[column], align(column));
          cellY += line.height;
        }
        x += columnWidths[column];
      }
      this.y += height;
      this.line(this.left, this.y, this.left + this.width, this.y, this.theme.tableBorder, isHeader ? 0.9 : 0.5);
    };

    this.ensureSpace(headerHeight * 2);
    const tableTop = { page: this.pages.length - 1, top: this.y };
    this.line(this.left, this.y, this.left + this.width, this.y, this.theme.tableBorder, 0.5);
    drawRow(headerLines, headerHeight, true);

    const verticals: { page: number; top: number; bottom: number }[] = [{ ...tableTop, bottom: this.y }];
    const extendVertical = (): void => {
      verticals[verticals.length - 1].bottom = this.y;
    };

    for (const row of bodyCells) {
      const lines = rowLines(row);
      const height = rowHeight(lines);
      if (this.y + height > this.contentBottom && this.y > this.contentTop + 0.01) {
        extendVertical();
        this.breakPage();
        verticals.push({ page: this.pages.length - 1, top: this.y, bottom: this.y });
        this.line(this.left, this.y, this.left + this.width, this.y, this.theme.tableBorder, 0.5);
        drawRow(rowLines(headerCells), headerHeight, true);
      }
      drawRow(lines, height, false);
      extendVertical();
    }

    for (const span of verticals) {
      let x = this.left;
      for (let column = 0; column <= columns; column++) {
        this.pages[span.page].background.push(
          [
            'q',
            `${rgb(this.theme.tableBorder)} RG`,
            '0.5 w',
            `${fmt(x)} ${fmt(this.pdfY(span.top))} m`,
            `${fmt(x)} ${fmt(this.pdfY(span.bottom))} l`,
            'S',
            'Q',
          ].join('\n'),
        );
        if (column < columns) x += columnWidths[column];
      }
    }
  }

  addFooters(): void {
    if (!this.options.pageNumbers) return;
    const size = this.options.fontSize * 0.78;
    const top = this.options.pageHeight - this.options.marginBottom + this.options.fontSize * 1.2;
    const total = this.pages.length;

    for (let index = 0; index < total; index++) {
      const label = `${index + 1} / ${total}`;
      const labelWidth = measure(label, 'regular', size);
      const right = this.options.pageWidth - this.options.marginRight - labelWidth;
      const emit = (text: string, x: number): void => {
        this.pages[index].body.push(
          [
            'BT',
            `/${fontResource('regular')} ${fmt(size)} Tf`,
            `${rgb(this.theme.muted)} rg`,
            `1 0 0 1 ${fmt(x)} ${fmt(this.pdfY(top))} Tm`,
            `${pdfString(text)} Tj`,
            'ET',
          ].join('\n'),
        );
      };
      if (this.options.title !== null && this.options.title !== '') {
        const maxWidth = right - this.options.marginLeft - size;
        let title = this.options.title;
        while (measure(title, 'regular', size) > maxWidth && title.length > 1) title = title.slice(0, -2) + '…';
        emit(title, this.options.marginLeft);
        emit(label, right);
      } else {
        emit(label, (this.options.pageWidth - labelWidth) / 2);
      }
    }
  }
}

/**
 * Max-min fair column sizing: narrow columns reach their natural width first and
 * the widest columns absorb whatever deficit is left.
 */
function distributeWidths(minimum: number[], natural: number[], available: number): number[] {
  const minTotal = minimum.reduce((a, b) => a + b, 0);
  if (minTotal >= available) {
    return minTotal === 0
      ? minimum.map(() => available / minimum.length)
      : minimum.map((w) => (w / minTotal) * available);
  }

  const widths = minimum.slice();
  const pending = new Set(widths.map((_, index) => index).filter((index) => natural[index] > widths[index]));
  let remaining = available - minTotal;

  while (remaining > 0.01 && pending.size > 0) {
    const share = remaining / pending.size;
    let progressed = false;
    for (const index of [...pending]) {
      const need = natural[index] - widths[index];
      if (need <= share) {
        widths[index] += need;
        remaining -= need;
        pending.delete(index);
        progressed = true;
      }
    }
    if (!progressed) {
      for (const index of pending) widths[index] += share;
      remaining = 0;
    }
  }

  if (remaining > 0.01) {
    const share = remaining / widths.length;
    for (let index = 0; index < widths.length; index++) widths[index] += share;
  }
  return widths;
}

function fontResource(font: FontKey): string {
  return `F${FONT_KEYS.indexOf(font) + 1}`;
}

function buildOutline(
  writer: PdfWriter,
  entries: OutlineEntry[],
  pageRefs: PdfRef[],
  parent: PdfRef,
): { first: PdfRef; last: PdfRef; count: number } | null {
  if (entries.length === 0) return null;

  interface Node {
    entry: OutlineEntry;
    children: Node[];
    ref: PdfRef;
  }

  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const entry of entries) {
    const node: Node = { entry, children: [], ref: writer.alloc() };
    while (stack.length > 0 && stack[stack.length - 1].entry.level >= entry.level) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  const write = (nodes: Node[], parentRef: PdfRef): number => {
    let total = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const childCount = write(node.children, node.ref);
      const dict: PdfDict = {
        Title: node.entry.title,
        Parent: parentRef,
        Prev: i > 0 ? nodes[i - 1].ref : undefined,
        Next: i < nodes.length - 1 ? nodes[i + 1].ref : undefined,
        Dest: [pageRefs[node.entry.page], name('XYZ'), null, node.entry.y, null] as PdfValue,
      };
      if (node.children.length > 0) {
        dict.First = node.children[0].ref;
        dict.Last = node.children[node.children.length - 1].ref;
        dict.Count = childCount;
      }
      writer.put(node.ref, dict);
      total += 1 + childCount;
    }
    return total;
  };

  const count = write(roots, parent);
  return { first: roots[0].ref, last: roots[roots.length - 1].ref, count };
}

export interface RenderResult {
  bytes: Buffer;
  pages: number;
}

/** Lays out a parsed Markdown document and returns the bytes of the resulting PDF. */
export function renderPdf(document: Document, options: RenderOptions): RenderResult {
  const layout = new Layout(options);
  layout.renderBlocks(document.blocks);
  layout.addFooters();

  const writer = new PdfWriter({ compress: options.compress });
  const catalog = writer.alloc();
  const pagesRef = writer.alloc();

  const fontRefs = new Map<FontKey, PdfRef>();
  for (const font of FONT_KEYS) {
    fontRefs.set(
      font,
      writer.add({
        Type: name('Font'),
        Subtype: name('Type1'),
        BaseFont: name(baseFontName(font)),
        Encoding: usesWinAnsi(font) ? name('WinAnsiEncoding') : undefined,
      }),
    );
  }

  const imageRefs = new Map<string, PdfRef>();
  for (const [, { resource, image }] of layout.images) {
    const smask =
      image.smask === null
        ? undefined
        : writer.add(
            {
              Type: name('XObject'),
              Subtype: name('Image'),
              Width: image.width,
              Height: image.height,
              ColorSpace: name('DeviceGray'),
              BitsPerComponent: image.smask.bitsPerComponent,
              Filter: name('FlateDecode'),
            },
            image.smask.data,
          );

    const colorSpace: PdfValue =
      typeof image.colorSpace === 'string'
        ? name(image.colorSpace)
        : [
            name('Indexed'),
            name('DeviceRGB'),
            image.colorSpace.indexed.hival,
            writer.add({}, image.colorSpace.indexed.lookup),
          ];

    imageRefs.set(
      resource,
      writer.add(
        {
          Type: name('XObject'),
          Subtype: name('Image'),
          Width: image.width,
          Height: image.height,
          ColorSpace: colorSpace,
          BitsPerComponent: image.bitsPerComponent,
          Filter: name(image.filter),
          DecodeParms: image.decodeParms === null ? undefined : (image.decodeParms as PdfValue),
          SMask: smask,
        },
        image.data,
      ),
    );
  }

  const fontDict: PdfDict = {};
  for (const [font, ref] of fontRefs) fontDict[fontResource(font)] = ref;

  const pageRefs = layout.allPages.map(() => writer.alloc());

  layout.allPages.forEach((page, index) => {
    const content = writer.add({}, [...page.background, ...page.body].join('\n'));
    const xobjects: PdfDict = {};
    for (const resource of page.images) {
      const ref = imageRefs.get(resource);
      if (ref !== undefined) xobjects[resource] = ref;
    }

    const annotations = page.annotations.map((annotation) =>
      writer.add({
        Type: name('Annot'),
        Subtype: name('Link'),
        Rect: annotation.rect.map((v) => Math.round(v * 100) / 100) as PdfValue,
        Border: [0, 0, 0] as PdfValue,
        A: { Type: name('Action'), S: name('URI'), URI: annotation.uri },
      }),
    );

    writer.put(pageRefs[index], {
      Type: name('Page'),
      Parent: pagesRef,
      MediaBox: [0, 0, options.pageWidth, options.pageHeight] as PdfValue,
      Resources: {
        Font: fontDict,
        XObject: page.images.size > 0 ? xobjects : undefined,
        ProcSet: [name('PDF'), name('Text'), name('ImageB'), name('ImageC'), name('ImageI')] as PdfValue,
      },
      Contents: content,
      Annots: annotations.length > 0 ? (annotations as PdfValue) : undefined,
    });
  });

  writer.put(pagesRef, {
    Type: name('Pages'),
    Kids: pageRefs as PdfValue,
    Count: pageRefs.length,
  });

  const outlinesRef = writer.alloc();
  const outline = buildOutline(writer, layout.outline, pageRefs, outlinesRef);
  writer.put(outlinesRef, {
    Type: name('Outlines'),
    First: outline?.first,
    Last: outline?.last,
    Count: outline?.count ?? 0,
  });

  const info = writer.add({
    Title: options.title ?? undefined,
    Author: options.author ?? undefined,
    Subject: options.subject ?? undefined,
    Producer: 'md-to-pdf (zero-dependency TypeScript on Node 24)',
    Creator: 'md-to-pdf',
    CreationDate: pdfDate(options.now),
  });

  writer.put(catalog, {
    Type: name('Catalog'),
    Pages: pagesRef,
    Outlines: outline === null ? undefined : outlinesRef,
    PageMode: outline === null ? undefined : name('UseOutlines'),
    Lang: 'en',
  });

  return { bytes: writer.build(catalog, info), pages: pageRefs.length };
}
