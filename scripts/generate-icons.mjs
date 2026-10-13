// Writes the toolbar/store icons (public/icons/{16,32,48,128}.png) with no image dependencies:
// a rounded electric-blue tile with a white "speech bubble" ring, drawn with 4x supersampling.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function coverage(x, y) {
  // Coordinates in a 0..1 square. Returns [tile, ring] coverage flags.
  const r = 0.22;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  const tile = dx * dx + dy * dy <= r * r;
  const d = Math.hypot(x - 0.5, y - 0.47);
  const ring = d <= 0.29 && d >= 0.17;
  // Bubble tail at the lower left.
  const tail = x > 0.24 && x < 0.42 && y > 0.62 && y < 0.82 && y - 0.62 < (0.42 - x) * 1.1;
  return [tile, ring || tail];
}

function png(size) {
  const ss = 4;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let tile = 0;
      let ring = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const [t, r] = coverage((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (t) tile++;
          if (t && r) ring++;
        }
      const n = ss * ss;
      const white = ring / n;
      const base = [0x2f, 0x5b, 0xff];
      const o = 1 + x * 4;
      for (let i = 0; i < 3; i++) row[o + i] = Math.round(base[i] * (1 - white / (tile / n || 1)) + 255 * (white / (tile / n || 1)));
      row[o + 3] = Math.round((tile / n) * 255);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`public/icons/${size}.png`, png(size));
console.log('icons written');
