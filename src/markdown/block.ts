import type { Align, Block, Document, Inline, LinkDefinitions, ListItem } from './types.ts';
import { normalizeLabel } from './types.ts';
import { parseInline } from './inline.ts';

const RE_THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*?))?[ \t]*$/;
const RE_FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const RE_BLOCKQUOTE = /^ {0,3}>/;
const RE_BULLET = /^( {0,3})([-*+])([ \t]+|$)/;
const RE_ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const RE_DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^<>\n]*>|\S+)[ \t]*(?:"([^"]*)"|'([^']*)'|\(([^()]*)\))?[ \t]*$/;
const RE_HTML_BLOCK = /^ {0,3}<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t>/]|$)|!--|\?|![A-Z])/;
const RE_TASK = /^\[([ xX])\][ \t]+/;

type RawBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'codeBlock'; lang: string; value: string }
  | { type: 'blockquote'; children: RawBlock[] }
  | { type: 'list'; ordered: boolean; start: number; tight: boolean; items: RawItem[] }
  | { type: 'thematicBreak' }
  | { type: 'table'; align: (Align | null)[]; header: string[]; rows: string[][] };

interface RawItem {
  checked: boolean | null;
  children: RawBlock[];
}

interface Marker {
  ordered: boolean;
  delim: string;
  value: number;
  contentIndent: number;
}

function expandTabs(line: string): string {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(4 - (out.length % 4));
    else out += ch;
  }
  return out;
}

function leadingSpaces(line: string): number {
  return /^ */.exec(line)![0].length;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function matchMarker(line: string): Marker | null {
  if (RE_THEMATIC.test(line)) return null;
  const bullet = RE_BULLET.exec(line);
  const ordered = bullet === null ? RE_ORDERED.exec(line) : null;
  const match = bullet ?? ordered;
  if (match === null) return null;

  const isOrdered = ordered !== null;
  const markerText = isOrdered ? match[2] + match[3] : match[2];
  const markerEnd = match[1].length + markerText.length;
  const rest = line.slice(markerEnd);
  const spacesAfter = leadingSpaces(rest);
  const contentIndent = isBlank(rest) || spacesAfter > 4 ? markerEnd + 1 : markerEnd + spacesAfter;

  return {
    ordered: isOrdered,
    delim: isOrdered ? match[3] : match[2],
    value: isOrdered ? Number.parseInt(match[2], 10) : 0,
    contentIndent,
  };
}

function startsNewBlock(line: string): boolean {
  return (
    RE_THEMATIC.test(line) ||
    RE_ATX.test(line) ||
    RE_FENCE.test(line) ||
    RE_BLOCKQUOTE.test(line) ||
    RE_HTML_BLOCK.test(line) ||
    matchMarker(line) !== null
  );
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const delim = lines[index + 1];
  if (delim === undefined || !header.includes('|')) return false;
  if (!RE_TABLE_DELIM.test(delim) || !delim.includes('-')) return false;
  return splitTableRow(header).length === splitTableRow(delim).length;
}

function splitTableRow(line: string): string[] {
  let source = line.trim();
  if (source.startsWith('|')) source = source.slice(1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\' && source[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '' || cells.length === 0) cells.push(current.trim());
  return cells;
}

function parseAlignment(cell: string): Align | null {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function collectDefinition(line: string, definitions: LinkDefinitions): boolean {
  const match = RE_DEFINITION.exec(line);
  if (match === null) return false;
  const href = match[2].startsWith('<') ? match[2].slice(1, -1) : match[2];
  const title = match[3] ?? match[4] ?? match[5] ?? null;
  const key = normalizeLabel(match[1]);
  if (!definitions.has(key)) definitions.set(key, { href, title });
  return true;
}

function parseBlocks(lines: string[], definitions: LinkDefinitions): RawBlock[] {
  const blocks: RawBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    if (RE_THEMATIC.test(line)) {
      blocks.push({ type: 'thematicBreak' });
      i++;
      continue;
    }

    const atx = RE_ATX.exec(line);
    if (atx !== null) {
      const text = (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      blocks.push({ type: 'heading', level: atx[1].length, text });
      i++;
      continue;
    }

    const fence = RE_FENCE.exec(line);
    if (fence !== null && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      const [, indent, marker, info] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const candidate = lines[i];
        const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \t]*$`);
        if (closing.test(candidate)) {
          i++;
          break;
        }
        body.push(candidate.slice(Math.min(indent.length, leadingSpaces(candidate))));
        i++;
      }
      blocks.push({ type: 'codeBlock', lang: info.trim().split(/\s+/)[0] ?? '', value: body.join('\n') });
      continue;
    }

    if (RE_BLOCKQUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const candidate = lines[i];
        if (RE_BLOCKQUOTE.test(candidate)) {
          inner.push(candidate.replace(/^ {0,3}>[ ]?/, ''));
          i++;
          continue;
        }
        if (isBlank(candidate) || startsNewBlock(candidate) || isTableStart(lines, i)) break;
        inner.push(candidate);
        i++;
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(inner, definitions) });
      continue;
    }

    const marker = matchMarker(line);
    if (marker !== null) {
      const [list, next] = parseList(lines, i, marker, definitions);
      blocks.push(list);
      i = next;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i]);
      const align = splitTableRow(lines[i + 1]).map(parseAlignment);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && !startsNewBlock(lines[i])) {
        const cells = splitTableRow(lines[i]);
        while (cells.length < header.length) cells.push('');
        rows.push(cells.slice(0, header.length));
        i++;
      }
      blocks.push({ type: 'table', align, header, rows });
      continue;
    }

    if (RE_HTML_BLOCK.test(line)) {
      while (i < lines.length && !isBlank(lines[i])) i++;
      continue;
    }

    if (/^ {4,}\S/.test(line)) {
      const body: string[] = [];
      let blanks: string[] = [];
      while (i < lines.length) {
        if (isBlank(lines[i])) {
          blanks.push('');
          i++;
          continue;
        }
        if (!/^ {4}/.test(lines[i])) break;
        body.push(...blanks, lines[i].slice(4));
        blanks = [];
        i++;
      }
      blocks.push({ type: 'codeBlock', lang: '', value: body.join('\n') });
      continue;
    }

    if (collectDefinition(line, definitions)) {
      i++;
      continue;
    }

    const paragraph: string[] = [line];
    i++;
    let heading = 0;
    while (i < lines.length) {
      const candidate = lines[i];
      if (isBlank(candidate)) break;
      const setext = RE_SETEXT.exec(candidate);
      if (setext !== null) {
        heading = setext[1][0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (startsNewBlock(candidate) || isTableStart(lines, i)) break;
      if (collectDefinition(candidate, definitions)) {
        i++;
        continue;
      }
      paragraph.push(candidate);
      i++;
    }
    const text = paragraph
      .map((l, index) => (index === paragraph.length - 1 ? l.trimEnd() : l).replace(/^ +/, ''))
      .join('\n')
      .trim();
    if (text !== '') {
      if (heading > 0) blocks.push({ type: 'heading', level: heading, text });
      else blocks.push({ type: 'paragraph', text });
    }
  }

  return blocks;
}

function parseList(
  lines: string[],
  start: number,
  first: Marker,
  definitions: LinkDefinitions,
): [RawBlock, number] {
  const items: RawItem[] = [];
  let loose = false;
  let i = start;

  while (i < lines.length) {
    const marker = matchMarker(lines[i]);
    if (marker === null || marker.ordered !== first.ordered || marker.delim !== first.delim) break;

    const body: string[] = [lines[i].slice(Math.min(marker.contentIndent, lines[i].length))];
    i++;
    let pendingBlanks = 0;
    let sawGap = false;

    while (i < lines.length) {
      const candidate = lines[i];
      if (isBlank(candidate)) {
        pendingBlanks++;
        i++;
        continue;
      }
      const indent = leadingSpaces(candidate);
      if (indent >= marker.contentIndent) {
        if (pendingBlanks > 0) {
          body.push('');
          sawGap = true;
          pendingBlanks = 0;
        }
        body.push(candidate.slice(marker.contentIndent));
        i++;
        continue;
      }
      if (pendingBlanks === 0 && !startsNewBlock(candidate) && !isTableStart(lines, i)) {
        body.push(candidate.trim());
        i++;
        continue;
      }
      break;
    }

    if (sawGap) loose = true;
    if (pendingBlanks > 0 && i < lines.length && matchMarker(lines[i]) !== null) loose = true;

    const children = parseBlocks(body, definitions);
    let checked: boolean | null = null;
    const head = children[0];
    if (head !== undefined && head.type === 'paragraph') {
      const task = RE_TASK.exec(head.text);
      if (task !== null) {
        checked = task[1] !== ' ';
        head.text = head.text.slice(task[0].length);
      }
    }
    items.push({ checked, children });
  }

  return [
    { type: 'list', ordered: first.ordered, start: first.ordered ? first.value : 1, tight: !loose, items },
    i,
  ];
}

function toBlocks(raw: RawBlock[], definitions: LinkDefinitions): Block[] {
  const inline = (text: string): Inline[] => parseInline(text, definitions);

  return raw.map((block): Block => {
    switch (block.type) {
      case 'heading':
        return { type: 'heading', level: block.level, children: inline(block.text) };
      case 'paragraph':
        return { type: 'paragraph', children: inline(block.text) };
      case 'codeBlock':
        return block;
      case 'thematicBreak':
        return block;
      case 'blockquote':
        return { type: 'blockquote', children: toBlocks(block.children, definitions) };
      case 'list':
        return {
          type: 'list',
          ordered: block.ordered,
          start: block.start,
          tight: block.tight,
          items: block.items.map((item): ListItem => ({
            checked: item.checked,
            children: toBlocks(item.children, definitions),
          })),
        };
      case 'table':
        return {
          type: 'table',
          align: block.align,
          header: block.header.map(inline),
          rows: block.rows.map((row) => row.map(inline)),
        };
    }
  });
}

/** Parses a Markdown document into a block AST plus its link reference definitions. */
export function parseMarkdown(source: string): Document {
  const lines = source
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(expandTabs);

  const definitions: LinkDefinitions = new Map();
  const raw = parseBlocks(lines, definitions);
  return { blocks: toBlocks(raw, definitions), definitions };
}
