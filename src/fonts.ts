export type FontKey = 'regular' | 'bold' | 'italic' | 'boldItalic' | 'mono' | 'monoBold' | 'symbol';

const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  556, 556, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 556, 611, 556,
  556, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 556, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0,
  556, 556, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 556, 611, 556,
  556, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 556, 500, 667,
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
  611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

const FIRST_CODE = 32;
const DEFAULT_WIDTH = 556;

interface FontMetrics {
  readonly baseFont: string;
  readonly widths: readonly number[] | null;
}

const METRICS: Record<FontKey, FontMetrics> = {
  regular: { baseFont: 'Helvetica', widths: HELVETICA },
  bold: { baseFont: 'Helvetica-Bold', widths: HELVETICA_BOLD },
  italic: { baseFont: 'Helvetica-Oblique', widths: HELVETICA },
  boldItalic: { baseFont: 'Helvetica-BoldOblique', widths: HELVETICA_BOLD },
  mono: { baseFont: 'Courier', widths: null },
  monoBold: { baseFont: 'Courier-Bold', widths: null },
  symbol: { baseFont: 'ZapfDingbats', widths: null },
};

/** ZapfDingbats is the only base-14 font with its own encoding rather than WinAnsi. */
export function usesWinAnsi(font: FontKey): boolean {
  return font !== 'symbol';
}

const DINGBATS: Record<number, string> = {
  0x2713: '3', 0x2714: '4', 0x2715: '5', 0x2716: '6', 0x2717: '7', 0x2718: '8',
  0x2705: '4', 0x2611: '4', 0x274c: '8', 0x2612: '8', 0x2719: '9',
};

const DINGBAT_WIDTH = 788;

export interface TextSegment {
  text: string;
  symbol: boolean;
}

/**
 * Splits text into runs that WinAnsi can render and runs that need ZapfDingbats,
 * translating the latter into their ZapfDingbats code points.
 */
export function splitSymbols(value: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let plain = '';
  let symbol = '';

  const flush = (): void => {
    if (plain !== '') {
      segments.push({ text: plain, symbol: false });
      plain = '';
    }
    if (symbol !== '') {
      segments.push({ text: symbol, symbol: true });
      symbol = '';
    }
  };

  for (const ch of value) {
    const mapped = DINGBATS[ch.codePointAt(0)!];
    if (mapped === undefined) {
      if (symbol !== '') flush();
      plain += ch;
    } else {
      if (plain !== '') flush();
      symbol += mapped;
    }
  }
  flush();
  return segments;
}

export const FONT_KEYS = Object.keys(METRICS) as FontKey[];

export function baseFontName(font: FontKey): string {
  return METRICS[font].baseFont;
}

const WIN_ANSI_HIGH = [
  0x20ac, 0x0000, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x0000, 0x017d, 0x0000,
  0x0000, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x0000, 0x017e, 0x0178,
];

const UNICODE_TO_WIN_ANSI = new Map<number, number>();
for (let i = 0; i < WIN_ANSI_HIGH.length; i++) {
  const cp = WIN_ANSI_HIGH[i];
  if (cp !== 0) UNICODE_TO_WIN_ANSI.set(cp, 0x80 + i);
}
for (const [from, to] of [
  [0x00a0, 0x20], [0x2010, 0x2d], [0x2011, 0x2d], [0x2012, 0x2d], [0x2015, 0x2014],
  [0x2212, 0x2d], [0x2032, 0x27], [0x2033, 0x22], [0x00ad, 0x2d], [0x2043, 0x2d],
  [0x2044, 0x2f], [0x2009, 0x20], [0x200a, 0x20], [0x2002, 0x20], [0x2003, 0x20],
] as const) {
  UNICODE_TO_WIN_ANSI.set(from, to < 0x100 ? to : UNICODE_TO_WIN_ANSI.get(to)!);
}

const TRANSLITERATE: Record<number, string> = {
  0x2190: '<-', 0x2192: '->', 0x2194: '<->', 0x21d0: '<=', 0x21d2: '=>', 0x21d4: '<=>',
  0x2260: '!=', 0x2264: '<=', 0x2265: '>=', 0x2248: '~', 0x2261: '==',
  0x2610: '[ ]', 0x26a0: '!', 0x2139: 'i',
  0x25cf: '\u2022', 0x25cb: '\u00b0', 0x25aa: '\u2022', 0x25ab: '\u2022',
  0x25e6: '\u2022', 0x2023: '\u2022',
  0x2500: '-', 0x2501: '-', 0x2502: '|', 0x2503: '|', 0x2504: '-', 0x2505: '-',
  0x2506: '|', 0x2507: '|', 0x2508: '-', 0x2509: '-', 0x250a: '|', 0x250b: '|',
  0x2571: '/', 0x2572: '\\', 0x2573: 'X',
};

function boxDrawing(cp: number): string | null {
  if (cp < 0x250c || cp > 0x256c) return null;
  return '+';
}

const FALLBACK_BYTE = 0x3f;

function toByte(cp: number): number {
  if (cp >= 0x20 && cp <= 0x7e) return cp;
  const mapped = UNICODE_TO_WIN_ANSI.get(cp);
  if (mapped !== undefined) return mapped;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return -1;
}

/** Encodes a JS string into a WinAnsiEncoding byte buffer, transliterating what it can. */
export function encodeWinAnsi(text: string): Buffer {
  const bytes: number[] = [];

  const pushAll = (value: string): boolean => {
    let pushed = false;
    for (const ch of value) {
      const code = toByte(ch.codePointAt(0)!);
      if (code >= 0) {
        bytes.push(code);
        pushed = true;
      }
    }
    return pushed;
  };

  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const direct = toByte(cp);
    if (direct >= 0) {
      bytes.push(direct);
      continue;
    }
    const replacement = TRANSLITERATE[cp] ?? boxDrawing(cp);
    if (replacement !== null && replacement !== undefined) {
      pushAll(replacement);
      continue;
    }
    if (!pushAll(ch.normalize('NFD').replace(/\p{M}/gu, ''))) bytes.push(FALLBACK_BYTE);
  }
  return Buffer.from(bytes);
}

/** Width of `text` in points when set in `font` at `size`. */
export function measure(text: string, font: FontKey, size: number): number {
  if (font === 'symbol') return (text.length * DINGBAT_WIDTH * size) / 1000;
  const widths = METRICS[font].widths;
  if (widths === null) return encodeWinAnsi(text).length * 0.6 * size;
  const bytes = encodeWinAnsi(text);
  let total = 0;
  for (const byte of bytes) {
    const w = widths[byte - FIRST_CODE];
    total += w === undefined || w === 0 ? DEFAULT_WIDTH : w;
  }
  return (total / 1000) * size;
}

export function isMono(font: FontKey): boolean {
  return font === 'mono' || font === 'monoBold';
}

export function boldOf(font: FontKey): FontKey {
  switch (font) {
    case 'regular': return 'bold';
    case 'italic': return 'boldItalic';
    case 'mono': return 'monoBold';
    default: return font;
  }
}

export function italicOf(font: FontKey): FontKey {
  switch (font) {
    case 'regular': return 'italic';
    case 'bold': return 'boldItalic';
    default: return font;
  }
}
