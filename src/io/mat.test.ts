import { describe, it, expect } from 'vitest';
import { encodeMatFile, type MatValue } from './mat';
import { buildInsightMat } from './exportInsight';
import type { InsightRow, InsightMeta } from '../hooks/useInsightData';

// ── Minimal MAT Level-5 reader, just for the round-trip assertions ───────────
// Parses the standard tag form this writer emits (no compression, no small
// elements). Mirrors the encoder's 8-byte alignment.

const pad8 = (n: number) => (n + 7) & ~7;

type Decoded =
  | { kind: 'double'; rows: number; cols: number; data: number[] }
  | { kind: 'char'; rows: number; cols: number; strings: string[] };

function readEl(dv: DataView, off: number) {
  const type = dv.getInt32(off, true);
  const nbytes = dv.getInt32(off + 4, true);
  const body = off + 8;
  return { type, nbytes, body, next: body + pad8(nbytes) };
}

function decodeMatFile(bytes: Uint8Array): Record<string, Decoded> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, Decoded> = {};
  let off = 128; // skip the header
  while (off < bytes.length) {
    const matrix = readEl(dv, off);
    expect(matrix.type).toBe(14); // miMATRIX
    let p = matrix.body;
    const flags = readEl(dv, p);
    p = flags.next;
    const klass = dv.getUint32(flags.body, true) & 0xff;
    const dims = readEl(dv, p);
    p = dims.next;
    const rows = dv.getInt32(dims.body, true);
    const cols = dv.getInt32(dims.body + 4, true);
    const nameEl = readEl(dv, p);
    p = nameEl.next;
    let name = '';
    for (let i = 0; i < nameEl.nbytes; i++) name += String.fromCharCode(bytes[nameEl.body + i]);
    const pr = readEl(dv, p);
    if (klass === 6) {
      const data: number[] = [];
      for (let i = 0; i < pr.nbytes / 8; i++) data.push(dv.getFloat64(pr.body + i * 8, true));
      out[name] = { kind: 'double', rows, cols, data };
    } else if (klass === 4) {
      const codes: number[] = [];
      for (let i = 0; i < pr.nbytes / 2; i++) codes.push(dv.getUint16(pr.body + i * 2, true));
      // Column-major rows×cols → per-row strings, trailing space padding removed.
      const strings: string[] = [];
      for (let r = 0; r < rows; r++) {
        let s = '';
        for (let c = 0; c < cols; c++) s += String.fromCharCode(codes[c * rows + r]);
        strings.push(s.replace(/ +$/, ''));
      }
      out[name] = { kind: 'char', rows, cols, strings };
    }
    off = matrix.next;
  }
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('encodeMatFile', () => {
  it('writes a valid 128-byte Level-5 header (version + little-endian tag)', () => {
    const bytes = encodeMatFile({});
    expect(bytes.length).toBe(128);
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint16(124, true)).toBe(0x0100); // version
    expect(bytes[126]).toBe(0x49); // 'I'
    expect(bytes[127]).toBe(0x4d); // 'M'  → "IM" = little-endian
    expect(String.fromCharCode(...bytes.subarray(0, 10))).toBe('MATLAB 5.0');
  });

  it('round-trips doubles (including NaN) and char arrays, preserving order', () => {
    const vars: Record<string, MatValue> = {
      Address: { type: 'char', value: 'TEST:SINE' },
      time_s: { type: 'double', rows: 3, cols: 1, data: [0.5, 1.5, 2.5] },
      value: { type: 'double', rows: 3, cols: 1, data: [1, NaN, 3] },
      severity: { type: 'charMatrix', rows: ['NO_ALARM', 'MAJOR', ''] },
    };
    const decoded = decodeMatFile(encodeMatFile(vars));

    expect(Object.keys(decoded)).toEqual(['Address', 'time_s', 'value', 'severity']);
    expect(decoded.Address).toMatchObject({ kind: 'char', rows: 1 });
    expect((decoded.Address as { strings: string[] }).strings[0]).toBe('TEST:SINE');
    expect((decoded.time_s as { data: number[] }).data).toEqual([0.5, 1.5, 2.5]);

    const val = (decoded.value as { data: number[] }).data;
    expect(val[0]).toBe(1);
    expect(Number.isNaN(val[1])).toBe(true);
    expect(val[2]).toBe(3);

    expect(decoded.severity).toMatchObject({ kind: 'char', rows: 3 });
    expect((decoded.severity as { strings: string[] }).strings).toEqual(['NO_ALARM', 'MAJOR', '']);
  });
});

describe('buildInsightMat', () => {
  it('emits Address/Unit/Description + per-column data with NaN/bool coercion', () => {
    const meta: InsightMeta = { pv: 'TEST:PV', units: 'kV', description: 'a desc' };
    const rows: InsightRow[] = [
      { tsNs: 1_000_000_000, value: 1.5, severity: 'NO_ALARM', source: 'Archive' },
      { tsNs: 2_000_000_000, value: null, severity: 'MAJOR', source: 'Live' },
      { tsNs: 3_000_000_000, value: true, severity: '', source: 'Archive' },
    ];
    const decoded = decodeMatFile(buildInsightMat(meta, rows));

    expect(Object.keys(decoded).sort()).toEqual(
      ['Address', 'Description', 'Unit', 'severity', 'source', 'time_s', 'value'].sort()
    );
    expect((decoded.Address as { strings: string[] }).strings[0]).toBe('TEST:PV');
    expect((decoded.Unit as { strings: string[] }).strings[0]).toBe('kV');
    expect((decoded.Description as { strings: string[] }).strings[0]).toBe('a desc');
    expect((decoded.time_s as { data: number[] }).data).toEqual([1, 2, 3]);

    const val = (decoded.value as { data: number[] }).data;
    expect(val[0]).toBe(1.5);
    expect(Number.isNaN(val[1])).toBe(true); // null → NaN
    expect(val[2]).toBe(1); // boolean true → 1

    expect((decoded.severity as { strings: string[] }).strings).toEqual(['NO_ALARM', 'MAJOR', '']);
    expect((decoded.source as { strings: string[] }).strings).toEqual([
      'Archive',
      'Live',
      'Archive',
    ]);
  });

  it('handles units/description being null', () => {
    const meta: InsightMeta = { pv: 'X:Y', units: null, description: null };
    const rows: InsightRow[] = [{ tsNs: 0, value: 0, severity: '', source: 'Archive' }];
    const decoded = decodeMatFile(buildInsightMat(meta, rows));
    expect((decoded.Unit as { strings: string[] }).strings[0]).toBe('');
    expect((decoded.Description as { strings: string[] }).strings[0]).toBe('');
  });
});
