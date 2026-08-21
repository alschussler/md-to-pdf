import type { Inline, LinkDefinitions } from './types.ts';
import { normalizeLabel } from './types.ts';

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  deg: '°', plusmn: '±', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', frac34: '¾', middot: '·',
  bull: '•', dagger: '†', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶',
  larr: '←', rarr: '→', harr: '↔', ne: '≠',
  le: '≤', ge: '≥', minus: '−', shy: '­',
};

const PUNCTUATION = /[!-#%-*,-\/:;?@\[-\]_{}¡§«¶·»¿‐-‧‰-⁞]/;

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'inline'; node: Inline }
  | { kind: 'delim'; char: string; count: number; original: number; canOpen: boolean; canClose: boolean }
  | { kind: 'wrap'; wrapper: 'em' | 'strong' | 'del'; children: Token[] };

function decodeEntity(source: string, index: number): { text: string; length: number } | null {
  const match = /^&(#[Xx][0-9A-Fa-f]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(source.slice(index));
  if (match === null) return null;
  const body = match[1];
  if (body.startsWith('#')) {
    const isHex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return { text: '�', length: match[0].length };
    return { text: String.fromCodePoint(code), length: match[0].length };
  }
  const replacement = ENTITIES[body];
  return replacement === undefined ? null : { text: replacement, length: match[0].length };
}

function isWhitespaceAt(source: string, index: number): boolean {
  if (index < 0 || index >= source.length) return true;
  return /\s/.test(source[index]);
}

function isPunctuationAt(source: string, index: number): boolean {
  if (index < 0 || index >= source.length) return false;
  return PUNCTUATION.test(source[index]);
}

function findClosingBracket(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      const fence = /^`+/.exec(source.slice(i))![0];
      const close = source.indexOf(fence, i + fence.length);
      i = close === -1 ? source.length : close + fence.length - 1;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

interface Destination {
  href: string;
  title: string | null;
  end: number;
}

function parseInlineDestination(source: string, start: number): Destination | null {
  let i = start + 1;
  while (i < source.length && /\s/.test(source[i])) i++;
  let href = '';
  if (source[i] === '<') {
    const close = source.indexOf('>', i);
    if (close === -1) return null;
    href = source.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\' && i + 1 < source.length) {
        href += source[i + 1];
        i += 2;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '(') depth++;
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      href += ch;
      i++;
    }
  }
  while (i < source.length && /\s/.test(source[i])) i++;
  let title: string | null = null;
  const quote = source[i];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closer = quote === '(' ? ')' : quote;
    let value = '';
    i++;
    while (i < source.length && source[i] !== closer) {
      if (source[i] === '\\' && i + 1 < source.length) {
        value += source[i + 1];
        i += 2;
        continue;
      }
      value += source[i++];
    }
    if (source[i] !== closer) return null;
    title = value;
    i++;
  }
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] !== ')') return null;
  return { href, title, end: i + 1 };
}

/** Finds the backtick run that closes a code span: it must be exactly `length` long. */
function findCodeSpanEnd(source: string, from: number, length: number): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] !== '`') continue;
    const run = /^`+/.exec(source.slice(i))![0].length;
    if (run === length) return i;
    i += run - 1;
  }
  return -1;
}

function stripCodeSpan(value: string): string {
  const collapsed = value.replace(/\r?\n/g, ' ');
  if (collapsed.length > 2 && collapsed.startsWith(' ') && collapsed.endsWith(' ') && collapsed.trim() !== '') {
    return collapsed.slice(1, -1);
  }
  return collapsed;
}

function tokenize(source: string, definitions: LinkDefinitions): Token[] {
  const tokens: Token[] = [];
  let text = '';

  const flush = (): void => {
    if (text !== '') {
      tokens.push({ kind: 'text', value: text });
      text = '';
    }
  };
  const emit = (node: Inline): void => {
    flush();
    tokens.push({ kind: 'inline', node });
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\') {
      const next = source[i + 1];
      if (next === '\n') {
        emit({ type: 'break' });
        i += 2;
        while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++;
        continue;
      }
      if (next !== undefined && PUNCTUATION.test(next)) {
        text += next;
        i += 2;
        continue;
      }
      text += ch;
      i++;
      continue;
    }

    if (ch === '\n') {
      const hardBreak = /[ ]{2,}$/.test(text);
      text = text.replace(/[ \t]+$/, '');
      if (hardBreak) emit({ type: 'break' });
      else text += ' ';
      i++;
      while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++;
      continue;
    }

    if (ch === '`') {
      const fence = /^`+/.exec(source.slice(i))![0];
      const close = findCodeSpanEnd(source, i + fence.length, fence.length);
      if (close !== -1) {
        emit({ type: 'code', value: stripCodeSpan(source.slice(i + fence.length, close)) });
        i = close + fence.length;
        continue;
      }
      text += fence;
      i += fence.length;
      continue;
    }

    if (ch === '<') {
      const autolink = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^\s<>@]+@[^\s<>@]+\.[A-Za-z]{2,})>/.exec(source.slice(i));
      if (autolink !== null) {
        const target = autolink[1];
        const href = target.includes('@') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) ? `mailto:${target}` : target;
        emit({ type: 'link', href, title: null, children: [{ type: 'text', value: target }] });
        i += autolink[0].length;
        continue;
      }
      const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*?)?\/?>|^<!--[\s\S]*?-->/.exec(source.slice(i));
      if (tag !== null) {
        if (/^<br\s*\/?>/i.test(tag[0])) emit({ type: 'break' });
        i += tag[0].length;
        continue;
      }
      text += ch;
      i++;
      continue;
    }

    if (ch === '&') {
      const entity = decodeEntity(source, i);
      if (entity !== null) {
        text += entity.text;
        i += entity.length;
        continue;
      }
      text += ch;
      i++;
      continue;
    }

    if (ch === '!' && source[i + 1] === '[') {
      const parsed = parseLinkLike(source, i + 1, definitions, true);
      if (parsed !== null) {
        emit(parsed.node);
        i = parsed.end;
        continue;
      }
      text += ch;
      i++;
      continue;
    }

    if (ch === '[') {
      const parsed = parseLinkLike(source, i, definitions, false);
      if (parsed !== null) {
        emit(parsed.node);
        i = parsed.end;
        continue;
      }
      text += ch;
      i++;
      continue;
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const run = new RegExp(`^\\${ch}+`).exec(source.slice(i))![0];
      const count = run.length;
      const beforeWhitespace = isWhitespaceAt(source, i - 1);
      const afterWhitespace = isWhitespaceAt(source, i + count);
      const beforePunctuation = isPunctuationAt(source, i - 1);
      const afterPunctuation = isPunctuationAt(source, i + count);
      const leftFlanking = !afterWhitespace && (!afterPunctuation || beforeWhitespace || beforePunctuation);
      const rightFlanking = !beforeWhitespace && (!beforePunctuation || afterWhitespace || afterPunctuation);

      let canOpen: boolean;
      let canClose: boolean;
      if (ch === '_') {
        canOpen = leftFlanking && (!rightFlanking || beforePunctuation);
        canClose = rightFlanking && (!leftFlanking || afterPunctuation);
      } else if (ch === '~') {
        canOpen = count === 2 && leftFlanking;
        canClose = count === 2 && rightFlanking;
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }

      if (!canOpen && !canClose) {
        text += run;
      } else {
        flush();
        tokens.push({ kind: 'delim', char: ch, count, original: count, canOpen, canClose });
      }
      i += count;
      continue;
    }

    const bareLink = /^(?:https?:\/\/|www\.)[^\s<>()[\]{}"']+/.exec(source.slice(i));
    if (bareLink !== null && (i === 0 || /[\s(<]/.test(source[i - 1]))) {
      const target = bareLink[0].replace(/[.,;:!?]+$/, '');
      const href = target.startsWith('www.') ? `http://${target}` : target;
      emit({ type: 'link', href, title: null, children: [{ type: 'text', value: target }] });
      i += target.length;
      continue;
    }

    text += ch;
    i++;
  }

  flush();
  return tokens;
}

function parseLinkLike(
  source: string,
  bracketStart: number,
  definitions: LinkDefinitions,
  isImage: boolean,
): { node: Inline; end: number } | null {
  const close = findClosingBracket(source, bracketStart + 1);
  if (close === -1) return null;
  const label = source.slice(bracketStart + 1, close);
  let cursor = close + 1;
  let href: string | null = null;
  let title: string | null = null;

  if (source[cursor] === '(') {
    const destination = parseInlineDestination(source, cursor);
    if (destination === null) return null;
    href = destination.href;
    title = destination.title;
    cursor = destination.end;
  } else {
    let refLabel = label;
    if (source[cursor] === '[') {
      const refClose = findClosingBracket(source, cursor + 1);
      if (refClose === -1) return null;
      const explicit = source.slice(cursor + 1, refClose);
      if (explicit.trim() !== '') refLabel = explicit;
      cursor = refClose + 1;
    }
    const definition = definitions.get(normalizeLabel(refLabel));
    if (definition === undefined) return null;
    href = definition.href;
    title = definition.title;
  }

  if (isImage) {
    const alt = plainText(parseInline(label, definitions));
    return { node: { type: 'image', src: href, alt, title }, end: cursor };
  }
  return { node: { type: 'link', href, title, children: parseInline(label, definitions) }, end: cursor };
}

function processEmphasis(tokens: Token[]): Token[] {
  const openers: number[] = [];
  const list = tokens.slice();

  for (let i = 0; i < list.length; i++) {
    const closer = list[i];
    if (closer.kind !== 'delim' || !closer.canClose) {
      if (closer.kind === 'delim' && closer.canOpen) openers.push(i);
      continue;
    }

    let matched = -1;
    for (let k = openers.length - 1; k >= 0; k--) {
      const index = openers[k];
      const opener = list[index];
      if (index >= i || opener.kind !== 'delim' || opener.char !== closer.char || !opener.canOpen) continue;
      if (opener.canClose || closer.canOpen) {
        const sum = opener.original + closer.original;
        if (sum % 3 === 0 && !(opener.original % 3 === 0 && closer.original % 3 === 0)) continue;
      }
      matched = k;
      break;
    }

    if (matched === -1) {
      if (closer.canOpen) openers.push(i);
      continue;
    }

    const openerIndex = openers[matched];
    const opener = list[openerIndex] as Extract<Token, { kind: 'delim' }>;
    const used = closer.char === '~' ? 2 : Math.min(2, opener.count, closer.count);
    const wrapper = closer.char === '~' ? 'del' : used === 2 ? 'strong' : 'em';

    const children = list.slice(openerIndex + 1, i);
    opener.count -= used;
    closer.count -= used;

    const replacement: Token[] = [];
    if (opener.count > 0) replacement.push(opener);
    replacement.push({ kind: 'wrap', wrapper, children: processEmphasis(children) });
    if (closer.count > 0) replacement.push(closer);

    list.splice(openerIndex, i - openerIndex + 1, ...replacement);
    openers.length = matched;
    i = openerIndex - 1;
  }

  return list;
}

function toInline(tokens: Token[]): Inline[] {
  const result: Inline[] = [];
  const pushText = (value: string): void => {
    if (value === '') return;
    const last = result[result.length - 1];
    if (last !== undefined && last.type === 'text') last.value += value;
    else result.push({ type: 'text', value });
  };

  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        pushText(token.value);
        break;
      case 'delim':
        pushText(token.char.repeat(token.count));
        break;
      case 'inline':
        result.push(token.node);
        break;
      case 'wrap':
        result.push({ type: token.wrapper, children: toInline(token.children) } as Inline);
        break;
    }
  }
  return result;
}

/** Parses a run of Markdown inline content into an inline AST. */
export function parseInline(source: string, definitions: LinkDefinitions): Inline[] {
  return toInline(processEmphasis(tokenize(source, definitions)));
}

/** Flattens inline content to plain text (used for alt text, outlines and metadata). */
export function plainText(nodes: Inline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
        out += node.value;
        break;
      case 'image':
        out += node.alt;
        break;
      case 'break':
        out += ' ';
        break;
      default:
        out += plainText(node.children);
    }
  }
  return out;
}
