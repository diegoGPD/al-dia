// Generates simple solid-color PNGs (placeholder pass icons until the owner
// drops real artwork into DATA_DIR/wallet/images).
const zlib = require('node:zlib');
const { crc32 } = require('./zip');

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Solid color with a subtle lighter square in the middle (so it's visibly an icon).
function solidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const inCore = x > width * 0.3 && x < width * 0.7 && y > height * 0.3 && y < height * 0.7;
      const o = row + 1 + x * 4;
      raw[o] = Math.min(255, r + (inCore ? 45 : 0));
      raw[o + 1] = Math.min(255, g + (inCore ? 45 : 0));
      raw[o + 2] = Math.min(255, b + (inCore ? 45 : 0));
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { solidPng };
