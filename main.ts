// Squeeze screenshots into the smallest PNG, 27 November 2026.
//
// One program answers all 8 instances of a set: each /input/<id>/image.png is a
// 1280x720 RGBA screenshot; the program writes /output/<id>/image.png, losslessly,
// in as few bytes as it can. Node 22, standard library only, no network.
//
// How it squeezes:
//   - Decode the input PNG to RGBA, then analyse it: whether every pixel is
//     opaque, whether every pixel is grey, and its colours when at most 256.
//   - Try every exact form the image can be written in: a palette (colour type 3,
//     its entries ordered by count or by luminance, transparent entries first so
//     tRNS stays short) when at most 256 colours; grey (0) or grey+alpha (4) when
//     every pixel is grey; RGB (2) or RGBA (6) otherwise; a single fully
//     transparent value no opaque pixel uses becomes a tRNS key instead of an
//     alpha channel.
//   - Try every filter per form: each row unfiltered or one fixed filter, or each
//     row its own by the minimum-sum heuristic, the fewest-distinct-pairs
//     heuristic, or brute force (each of the five filters compressed by zlib
//     after the 32 KiB written before it, the smallest kept).
//   - Screen every form and filter at zlib level 6, keep the smallest, then
//     re-compress the winner at level 9, in several shapes (plain, and split
//     into fresh Huffman blocks at row-group boundaries with Z_SYNC_FLUSH, at
//     level 9 and at level 6, default and filtered strategy), and keep the
//     smallest file. Splitting blocks at content boundaries lets each region's
//     Huffman table fit its own statistics.
//   - Deterministic: the same work every run, no clock, no environment input,
//     no randomness, so two executions write the same bytes.
//
// Permissions (the fix for the Round 1 run_completes rejections of the first
// six entries): umask 022 before the first mkdir, every chmod best-effort in
// try/catch (the grader may run as another user on a pre-created /output it
// does not own, so a chmod failure must never fail the run), outputs written
// mode 0644.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { constants, createDeflateRaw, deflateSync, inflateSync } from 'node:zlib';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- CRC32 and Adler32 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------- PNG writing ----------

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  d[8] = 8; d[9] = colourType; d[10] = 0; d[11] = 0; d[12] = 0;
  return d;
}

function pngOf(chunks) {
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  let len = 8;
  for (const [type, data] of chunks) {
    const c = chunk(type, data);
    parts.push(c);
    len += c.length;
  }
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------- PNG decoding (to RGBA) ----------

function paeth(left, above, upLeft) {
  const p = left + above - upLeft;
  const pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return above;
  return upLeft;
}

function decodePng(bytes) {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    throw new Error('not a PNG');
  }
  let at = 8;
  let width = 0, height = 0, bitDepth = 0, colourType = 0, interlace = 0;
  let plte = null, trns = null;
  const idatParts = [];
  while (at + 12 <= bytes.length) {
    const len = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = dv.getUint32(0); height = dv.getUint32(4);
      bitDepth = data[8]; colourType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idatParts.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('unsupported PNG (bit depth / interlace)');
  if (![0, 2, 3, 4, 6].includes(colourType)) throw new Error('unsupported colour type ' + colourType);
  const idatLen = idatParts.reduce((s, p) => s + p.length, 0);
  const idat = new Uint8Array(idatLen);
  let off = 0;
  for (const p of idatParts) { idat.set(p, off); off += p.length; }
  const raw = inflateSync(idat);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  const stride = width * ch;
  if (raw.length !== height * (stride + 1)) throw new Error('bad IDAT length');
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      const v = row[x];
      if (f === 0) cur[x] = v;
      else if (f === 1) cur[x] = (v + a) & 0xff;
      else if (f === 2) cur[x] = (v + b) & 0xff;
      else if (f === 3) cur[x] = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) cur[x] = (v + paeth(a, b, c)) & 0xff;
      else throw new Error('bad filter ' + f);
    }
    prev.set(cur);
    for (let x = 0; x < width; x++) {
      const s = x * ch, d = (y * width + x) * 4;
      if (colourType === 6) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1]; rgba[d + 2] = cur[s + 2]; rgba[d + 3] = cur[s + 3];
      } else if (colourType === 2) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1]; rgba[d + 2] = cur[s + 2]; rgba[d + 3] = 255;
      } else if (colourType === 0) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s]; rgba[d + 2] = cur[s]; rgba[d + 3] = 255;
      } else if (colourType === 4) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s]; rgba[d + 2] = cur[s]; rgba[d + 3] = cur[s + 1];
      } else {
        const idx = cur[s] * 3;
        rgba[d] = plte[idx]; rgba[d + 1] = plte[idx + 1]; rgba[d + 2] = plte[idx + 2];
        rgba[d + 3] = trns && cur[s] < trns.length ? trns[cur[s]] : 255;
      }
    }
  }
  return { width, height, rgba };
}

// ---------- Analysis ----------

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0, 'minsum', 'brute']],
      ['luminance', [0, 'minsum', 'pairs', 'brute']],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}

// ---------- Filters ----------

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  for (let x = 0; x < n; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= bpp ? prev[x - bpp] : 0;
    if (type === 1) out[x] = (cur[x] - a) & 0xff;
    else if (type === 2) out[x] = (cur[x] - b) & 0xff;
    else if (type === 3) out[x] = (cur[x] - ((a + b) >> 1)) & 0xff;
    else out[x] = (cur[x] - paeth(a, b, c)) & 0xff;
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function filtered(samples, width, height, bpp, choice, raw) {
  const stride = width * bpp;
  if (!raw) raw = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------- Compression ----------

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

function chunkBytes(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

function screen(rgba, width, height) {
  let best = null;
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, bytes };
      } else spare = data;
    }
  }
  return best;
}

// The raw deflate stream of `data`, split into fresh Huffman blocks at every
// `everyRows` rows with Z_SYNC_FLUSH, so each content region gets its own
// Huffman table. Still one zlib stream once wrapped with a header and Adler32.
async function deflateFlushSplit(data, rows, stride, everyRows, level, strategy) {
  const d = createDeflateRaw({ level, memLevel: 9, strategy });
  const chunks = [];
  d.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { d.on('end', resolve); d.on('error', reject); });
  for (let y = 0; y < rows; y += everyRows) {
    const end = Math.min(rows, y + everyRows);
    await new Promise((res) => { d.write(data.subarray(y * stride, end * stride), () => res()); });
    if (end < rows) await new Promise((res) => { d.flush(constants.Z_SYNC_FLUSH, () => res()); });
  }
  d.end();
  await done;
  return Buffer.concat(chunks);
}

async function bestZlib(data, width, height, bpp) {
  const stride = width * bpp + 1;
  const plain = deflateSync(data, { level: 9, memLevel: 9 });
  let best = { stream: plain, bytes: plain.length };
  // The Adler32 of the uncompressed data, for the zlib wrapper of the
  // flush-split raw streams below.
  const ad = adler32(data);
  const tail = Buffer.from([(ad >>> 24) & 0xff, (ad >>> 16) & 0xff, (ad >>> 8) & 0xff, ad & 0xff]);
  const variants = [
    { every: 30, level: 9, strategy: constants.Z_DEFAULT_STRATEGY },
    { every: 60, level: 9, strategy: constants.Z_DEFAULT_STRATEGY },
    { every: 120, level: 9, strategy: constants.Z_DEFAULT_STRATEGY },
    { every: 240, level: 9, strategy: constants.Z_DEFAULT_STRATEGY },
    { every: 120, level: 9, strategy: constants.Z_FILTERED },
    { every: 120, level: 6, strategy: constants.Z_DEFAULT_STRATEGY },
  ];
  for (const v of variants) {
    const raw = await deflateFlushSplit(data, height, stride, v.every, v.level, v.strategy);
    const head = v.level >= 9 ? Buffer.from([0x78, 0xda]) : Buffer.from([0x78, 0x9c]);
    const wrapped = Buffer.concat([head, raw, tail]);
    if (wrapped.length < best.bytes) best = { stream: wrapped, bytes: wrapped.length };
  }
  return best.stream;
}

// ---------- Entry ----------

async function squeezeOne(id) {
  const inPath = join(I, id, 'image.png');
  const outDir = join(O, id);
  const outPath = join(outDir, 'image.png');
  const bytes = new Uint8Array(readFileSync(inPath));
  const img = decodePng(bytes);
  const { form, data } = screen(img.rgba, img.width, img.height);
  const stream = await bestZlib(data, img.width, img.height, form.bpp);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, pngOfForm(img.width, img.height, form, stream), { mode: 0o644 });
  try { chmodSync(outDir, 0o755); } catch {}
  try { chmodSync(outPath, 0o644); } catch {}
}

process.umask(0o022);
try { chmodSync(O, 0o755); } catch {}
for (const id of readdirSync(I).sort()) {
  let st;
  try { st = lstatSync(join(I, id)); } catch { continue; }
  if (!st.isDirectory()) continue;
  try {
    await squeezeOne(id);
  } catch (e) {
    // Fallback: copy the stored input so the instance is still answered in
    // format (0 points) instead of missing.
    try {
      mkdirSync(join(O, id), { recursive: true });
      copyFileSync(join(I, id, 'image.png'), join(O, id, 'image.png'));
      try { chmodSync(join(O, id), 0o755); } catch {}
      try { chmodSync(join(O, id, 'image.png'), 0o644); } catch {}
    } catch {}
  }
}
