const UNITS_PER_POINT: Record<string, number> = {
  pt: 1,
  px: 0.75,
  mm: 72 / 25.4,
  cm: 72 / 2.54,
  in: 72,
};

export const PAGE_SIZES: Record<string, [number, number]> = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
};

/**
 * Converts a CSS-like length to PDF points. Accepts pt (the default), px at
 * 96 dpi, mm, cm and in. e.g. "15mm" → 42.52, "12" → 12, "0.75in" → 54
 */
export function parseLength(value: string, flag: string): number {
  const match = /^(-?\d*\.?\d+)(pt|px|mm|cm|in)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `${flag} requires a length such as 12, 11pt, 15mm, 1cm or 0.75in, got: ${value}`,
    );
  }
  return parseFloat(match[1]) * UNITS_PER_POINT[(match[2] ?? "pt").toLowerCase()];
}

/**
 * Expands 1, 2 or 4 lengths into [top, right, bottom, left], following the
 * same shorthand order as CSS. e.g. "20mm" → all four, "10mm 20mm" → y then x
 */
export function parseMargins(value: string, flag: string): [number, number, number, number] {
  const parts = value.trim().split(/[\s,]+/).map((part) => parseLength(part, flag));
  switch (parts.length) {
    case 1: return [parts[0], parts[0], parts[0], parts[0]];
    case 2: return [parts[0], parts[1], parts[0], parts[1]];
    case 3: return [parts[0], parts[1], parts[2], parts[1]];
    case 4: return [parts[0], parts[1], parts[2], parts[3]];
    default:
      throw new Error(`${flag} takes 1, 2 or 4 lengths, got ${parts.length}: ${value}`);
  }
}

/**
 * Resolves a named page size or an explicit WxH pair into points.
 * e.g. "a4" → [595.28, 841.89], "210mmx297mm" → the same
 */
export function parsePageSize(value: string, flag: string): [number, number] {
  const named = PAGE_SIZES[value.trim().toLowerCase()];
  if (named) {
    return named;
  }

  const custom = /^([^x]+)x(.+)$/i.exec(value.trim());
  if (!custom) {
    throw new Error(
      `${flag} expects ${Object.keys(PAGE_SIZES).join(", ")} or an explicit size ` +
      `such as 210mmx297mm, got: ${value}`,
    );
  }
  return [parseLength(custom[1], flag), parseLength(custom[2], flag)];
}
