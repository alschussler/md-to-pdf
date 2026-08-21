import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

export type ColorSpace =
  | 'DeviceGray'
  | 'DeviceRGB'
  | 'DeviceCMYK'
  | { indexed: { hival: number; lookup: Buffer } };

export interface EmbeddedImage {
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: ColorSpace;
  filter: 'FlateDecode' | 'DCTDecode';
  data: Buffer;
  decodeParms: Record<string, number> | null;
  smask: { data: Buffer; bitsPerComponent: number } | null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngChunks {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  idat: Buffer;
  palette: Buffer | null;
  transparency: Buffer | null;
}

function readPngChunks(buffer: Buffer): PngChunks | null {
  let offset = 8;
  const idat: Buffer[] = [];
  let header: Omit<PngChunks, 'idat' | 'palette' | 'transparency'> | null = null;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
      if (data[10] !== 0 || data[11] !== 0) return null;
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IEND') break;
  }

  if (header === null || idat.length === 0) return null;
  return { ...header, idat: Buffer.concat(idat), palette, transparency };
}

function channelCount(colorType: number): number {
  switch (colorType) {
    case 0: return 1;
    case 2: return 3;
    case 3: return 1;
    case 4: return 2;
    case 6: return 4;
    default: return 0;
  }
}

function unfilter(raw: Buffer, height: number, bytesPerRow: number, bytesPerPixel: number): Buffer {
  const out = Buffer.alloc(height * bytesPerRow);
  let source = 0;

  for (let row = 0; row < height; row++) {
    const filter = raw[source++];
    const target = row * bytesPerRow;
    const previous = target - bytesPerRow;

    for (let x = 0; x < bytesPerRow; x++) {
      const value = raw[source + x];
      const left = x >= bytesPerPixel ? out[target + x - bytesPerPixel] : 0;
      const up = row > 0 ? out[previous + x] : 0;
      const upLeft = row > 0 && x >= bytesPerPixel ? out[previous + x - bytesPerPixel] : 0;

      let result: number;
      switch (filter) {
        case 0: result = value; break;
        case 1: result = value + left; break;
        case 2: result = value + up; break;
        case 3: result = value + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          result = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: return out;
      }
      out[target + x] = result & 0xff;
    }
    source += bytesPerRow;
  }
  return out;
}

function splitAlpha(png: PngChunks): EmbeddedImage | null {
  const channels = channelCount(png.colorType);
  const sampleBytes = png.bitDepth / 8;
  if (sampleBytes !== 1 && sampleBytes !== 2) return null;

  const bytesPerPixel = channels * sampleBytes;
  const bytesPerRow = png.width * bytesPerPixel;
  const pixels = unfilter(inflateSync(png.idat), png.height, bytesPerRow, bytesPerPixel);

  const colorChannels = channels - 1;
  const color = Buffer.alloc(png.width * png.height * colorChannels * sampleBytes);
  const alpha = Buffer.alloc(png.width * png.height * sampleBytes);

  let colorAt = 0;
  let alphaAt = 0;
  for (let pixel = 0; pixel < png.width * png.height; pixel++) {
    const base = pixel * bytesPerPixel;
    for (let c = 0; c < colorChannels * sampleBytes; c++) color[colorAt++] = pixels[base + c];
    for (let b = 0; b < sampleBytes; b++) alpha[alphaAt++] = pixels[base + colorChannels * sampleBytes + b];
  }

  return {
    width: png.width,
    height: png.height,
    bitsPerComponent: png.bitDepth,
    colorSpace: colorChannels === 3 ? 'DeviceRGB' : 'DeviceGray',
    filter: 'FlateDecode',
    data: deflateSync(color, { level: 9 }),
    decodeParms: null,
    smask: { data: deflateSync(alpha, { level: 9 }), bitsPerComponent: png.bitDepth },
  };
}

function readPng(buffer: Buffer): EmbeddedImage | null {
  const png = readPngChunks(buffer);
  if (png === null || png.interlace !== 0) return null;

  const channels = channelCount(png.colorType);
  if (channels === 0) return null;
  if (png.colorType === 4 || png.colorType === 6) return splitAlpha(png);
  if (png.colorType === 3 && png.palette === null) return null;

  const colorSpace: ColorSpace =
    png.colorType === 3
      ? { indexed: { hival: png.palette!.length / 3 - 1, lookup: png.palette! } }
      : png.colorType === 2
        ? 'DeviceRGB'
        : 'DeviceGray';

  return {
    width: png.width,
    height: png.height,
    bitsPerComponent: png.bitDepth,
    colorSpace,
    filter: 'FlateDecode',
    data: png.idat,
    decodeParms: {
      Predictor: 15,
      Colors: png.colorType === 2 ? 3 : 1,
      BitsPerComponent: png.bitDepth,
      Columns: png.width,
    },
    smask: null,
  };
}

function readJpeg(buffer: Buffer): EmbeddedImage | null {
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrame) {
      const precision = buffer[offset + 4];
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      const components = buffer[offset + 9];
      const colorSpace: ColorSpace | null =
        components === 1 ? 'DeviceGray' : components === 3 ? 'DeviceRGB' : components === 4 ? 'DeviceCMYK' : null;
      if (colorSpace === null) return null;
      return {
        width,
        height,
        bitsPerComponent: precision,
        colorSpace,
        filter: 'DCTDecode',
        data: buffer,
        decodeParms: null,
        smask: null,
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** Loads a local PNG or JPEG into a PDF-ready image XObject payload, or null if unsupported. */
export function loadImage(path: string): EmbeddedImage | null {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return null;
  }
  try {
    if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return readPng(buffer);
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return readJpeg(buffer);
  } catch {
    return null;
  }
  return null;
}
