import { deflateSync } from 'node:zlib';
import { encodeWinAnsi } from './fonts.ts';

export class PdfRef {
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

export class PdfName {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export class PdfRaw {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export type PdfValue =
  | string
  | number
  | boolean
  | null
  | PdfRef
  | PdfName
  | PdfRaw
  | PdfValue[]
  | { [key: string]: PdfValue | undefined };

export type PdfDict = { [key: string]: PdfValue | undefined };

/** Shorthand for a PDF name object (`/Foo`). */
export function name(value: string): PdfName {
  return new PdfName(value);
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeString(text: string): string {
  const bytes = encodeWinAnsi(text);
  let out = '';
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += '\\' + String.fromCharCode(byte);
    else if (byte < 0x20 || byte > 0x7e) out += '\\' + byte.toString(8).padStart(3, '0');
    else out += String.fromCharCode(byte);
  }
  return `(${out})`;
}

/** Escapes text as a PDF literal string, ready to drop into a content stream. */
export function pdfString(text: string): string {
  return escapeString(text);
}

function serialize(value: PdfValue | undefined): string {
  if (value === undefined || value === null) return 'null';
  if (value instanceof PdfRef) return `${value.id} 0 R`;
  if (value instanceof PdfName) return `/${value.value}`;
  if (value instanceof PdfRaw) return value.value;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return escapeString(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(' ')}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return `<<${entries.map(([k, v]) => `/${k} ${serialize(v)}`).join(' ')}>>`;
}

interface PdfObject {
  dict: PdfDict;
  stream: Buffer | null;
}

/**
 * Incremental writer for a PDF 1.7 file: allocate references up front, fill
 * them in any order, then `build()` the byte stream with a classic xref table.
 */
export class PdfWriter {
  private readonly objects: (PdfObject | null)[] = [];
  private compress: boolean;

  constructor(options: { compress?: boolean } = {}) {
    this.compress = options.compress !== false;
  }

  /** Reserves an object number that can be referenced before it is filled in. */
  alloc(): PdfRef {
    this.objects.push(null);
    return new PdfRef(this.objects.length);
  }

  /** Assigns a dictionary (and optional stream payload) to a reserved reference. */
  put(ref: PdfRef, dict: PdfDict, stream?: Buffer | string): PdfRef {
    let payload: Buffer | null = null;
    if (stream !== undefined) {
      payload = typeof stream === 'string' ? Buffer.from(stream, 'latin1') : stream;
      if (this.compress && dict.Filter === undefined && payload.length > 128) {
        payload = deflateSync(payload, { level: 9 });
        dict = { ...dict, Filter: name('FlateDecode') };
      }
      dict = { ...dict, Length: payload.length };
    }
    this.objects[ref.id - 1] = { dict, stream: payload };
    return ref;
  }

  /** Allocates and fills a reference in one step. */
  add(dict: PdfDict, stream?: Buffer | string): PdfRef {
    return this.put(this.alloc(), dict, stream);
  }

  build(root: PdfRef, info?: PdfRef): Buffer {
    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let position = 0;

    const push = (data: string | Buffer): void => {
      const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
      chunks.push(buf);
      position += buf.length;
    };

    push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');

    for (let i = 0; i < this.objects.length; i++) {
      const object = this.objects[i];
      if (object === null) throw new Error(`PDF object ${i + 1} was allocated but never written`);
      offsets.push(position);
      push(`${i + 1} 0 obj\n${serialize(object.dict as PdfValue)}\n`);
      if (object.stream !== null) {
        push('stream\n');
        push(object.stream);
        push('\nendstream\n');
      }
      push('endobj\n');
    }

    const xrefStart = position;
    const count = this.objects.length + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    push(xref);
    push(`trailer\n${serialize({ Size: count, Root: root, Info: info } as PdfValue)}\n`);
    push(`startxref\n${xrefStart}\n%%EOF\n`);

    return Buffer.concat(chunks);
  }
}

/** Formats a PDF date string (`D:YYYYMMDDHHmmSS+ZZ'zz'`). */
export function pdfDate(date: Date): string {
  const pad = (n: number): string => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  return (
    `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `${sign}${pad(offsetMinutes / 60)}'${pad(offsetMinutes % 60)}'`
  );
}
