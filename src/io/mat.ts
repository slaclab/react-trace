// Minimal, dependency-free writer for uncompressed MATLAB Level-5 (.mat) files.
//
// This is just enough of the MAT-File format to serialize the flat set of
// variables the Data Insight Tool exports (numeric column vectors + char
// arrays) — the same shape scipy.io.savemat produces by default. It is NOT a
// general MAT writer: only 2-D real double arrays and char arrays are
// supported, always little-endian, and always using the standard (non
// "small-element") tag form for simplicity. Output is readable by MATLAB and
// scipy.io.loadmat.
//
// Reference: "MAT-File Format" (MathWorks), Level 5.

// Data type tags (miXXX) used in element headers.
const miINT8 = 1;
const miUINT16 = 4;
const miINT32 = 5;
const miUINT32 = 6;
const miDOUBLE = 9;
const miMATRIX = 14;

// Array classes (mxXXX).
const mxCHAR_CLASS = 4;
const mxDOUBLE_CLASS = 6;

export type MatValue =
  | { type: 'double'; rows: number; cols: number; data: number[] } // column-major
  | { type: 'char'; value: string } // 1×N char row
  | { type: 'charMatrix'; rows: string[] }; // N×maxLen, space-padded

// Round up to the next multiple of 8 (MAT data elements are 8-byte aligned).
function pad8(n: number): number {
  return (n + 7) & ~7;
}

function ascii(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

// Build one data element: 8-byte tag (type, byteCount) + data + zero padding to
// an 8-byte boundary. byteCount is the *unpadded* data length, per spec.
function element(type: number, data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(8 + pad8(data.length));
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, type, true);
  dv.setInt32(4, data.length, true);
  buf.set(data, 8);
  return buf;
}

function i32Bytes(values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 4);
  const dv = new DataView(buf.buffer);
  values.forEach((v, i) => dv.setInt32(i * 4, v, true));
  return buf;
}

function u32Bytes(values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 4);
  const dv = new DataView(buf.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v, true));
  return buf;
}

function f64Bytes(values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 8);
  const dv = new DataView(buf.buffer);
  values.forEach((v, i) => dv.setFloat64(i * 8, v, true));
  return buf;
}

function u16Bytes(values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 2);
  const dv = new DataView(buf.buffer);
  values.forEach((v, i) => dv.setUint16(i * 2, v, true));
  return buf;
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Resolve a MatValue to its array class, dimensions, and the "real part" data
// element (the actual values, column-major as MATLAB expects).
function realPart(value: MatValue): { klass: number; rows: number; cols: number; pr: Uint8Array } {
  if (value.type === 'double') {
    const { rows, cols, data } = value;
    return { klass: mxDOUBLE_CLASS, rows, cols, pr: element(miDOUBLE, f64Bytes(data)) };
  }
  if (value.type === 'char') {
    // Iterate UTF-16 code units (not codepoints) so non-BMP characters keep
    // both surrogates; MATLAB char arrays are UTF-16. This matches the
    // charMatrix branch below, which indexes with charCodeAt(c).
    const s = value.value;
    const codes: number[] = [];
    for (let c = 0; c < s.length; c++) codes.push(s.charCodeAt(c));
    return {
      klass: mxCHAR_CLASS,
      rows: 1,
      cols: codes.length,
      pr: element(miUINT16, u16Bytes(codes)),
    };
  }
  // charMatrix: N rows, space-padded to the longest, stored column-major.
  const strs = value.rows;
  const n = strs.length;
  // At least one column: an N×0 char array is valid MAT but trips up some
  // third-party readers, so all-empty rows still get a single space column.
  const maxLen = Math.max(
    1,
    strs.reduce((m, s) => Math.max(m, s.length), 0)
  );
  const codes: number[] = [];
  for (let c = 0; c < maxLen; c++) {
    for (let r = 0; r < n; r++) {
      const s = strs[r];
      codes.push(c < s.length ? s.charCodeAt(c) : 0x20); // pad short rows with spaces
    }
  }
  return { klass: mxCHAR_CLASS, rows: n, cols: maxLen, pr: element(miUINT16, u16Bytes(codes)) };
}

// One top-level variable = an miMATRIX element wrapping four sub-elements:
// array flags, dimensions, name, and the real part.
function variableElement(name: string, value: MatValue): Uint8Array {
  const { klass, rows, cols, pr } = realPart(value);
  const arrayFlags = element(miUINT32, u32Bytes([klass, 0]));
  const dims = element(miINT32, i32Bytes([rows, cols]));
  const nameEl = element(miINT8, ascii(name));
  return element(miMATRIX, concat([arrayFlags, dims, nameEl, pr]));
}

// Fixed 128-byte Level-5 header (no timestamp, so output is deterministic).
// Bytes 0–123: descriptive text, space-padded (the subsystem-data-offset field
// at bytes 116–123 is left as spaces — there is no subsystem data).
// Bytes 124–125: version 0x0100. Bytes 126–127: endian tag "IM" (little-endian).
function header(): Uint8Array {
  const buf = new Uint8Array(128);
  buf.fill(0x20, 0, 124); // spaces across the text + subsys-offset region
  buf.set(ascii('MATLAB 5.0 MAT-file, Created by react-trace').subarray(0, 116), 0);
  new DataView(buf.buffer).setUint16(124, 0x0100, true); // version
  buf[126] = 0x49; // 'I'
  buf[127] = 0x4d; // 'M'
  return buf;
}

// Serialize a flat map of named variables into a complete .mat byte buffer.
export function encodeMatFile(vars: Record<string, MatValue>): Uint8Array<ArrayBuffer> {
  const chunks = [header()];
  for (const [name, value] of Object.entries(vars)) chunks.push(variableElement(name, value));
  return concat(chunks);
}
