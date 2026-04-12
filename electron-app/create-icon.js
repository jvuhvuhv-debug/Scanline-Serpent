const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Create a minimal but valid 512x512 RGB PNG
const width = 512;
const height = 512;

// PNG file signature
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// CRC32 calculation
const crc32 = (buf) => {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crc ^ buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// Helper to create PNG chunks
const createChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const chunk = Buffer.concat([Buffer.from(type), data]);
  const crcValue = crc32(chunk);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcValue, 0);
  return Buffer.concat([len, chunk, crcBuf]);
};

// IHDR chunk
const ihdrData = Buffer.alloc(13);
ihdrData.writeUInt32BE(width, 0);
ihdrData.writeUInt32BE(height, 4);
ihdrData[8] = 8;  // bit depth
ihdrData[9] = 2;  // color type RGB
ihdrData[10] = 0; // compression
ihdrData[11] = 0; // filter
ihdrData[12] = 0; // interlace
const ihdr = createChunk('IHDR', ihdrData);

// Create image data (green with scanline pattern)
const rawData = [];
for (let y = 0; y < height; y++) {
  rawData.push(0); // filter type
  for (let x = 0; x < width; x++) {
    if (y % 4 === 0) {
      rawData.push(0, 255, 0); // bright green
    } else {
      rawData.push(0, 100, 0); // dark green
    }
  }
}

const rawBuffer = Buffer.from(rawData);
const compressed = zlib.deflateSync(rawBuffer);
const idat = createChunk('IDAT', compressed);

// IEND chunk
const iend = createChunk('IEND', Buffer.alloc(0));

// Combine all chunks
const pngData = Buffer.concat([signature, ihdr, idat, iend]);

// Write file
const outputPath = path.join(__dirname, 'assets', 'icon.png');
fs.writeFileSync(outputPath, pngData);

console.log('✓ Icon created: ' + outputPath);
console.log('✓ Size: ' + pngData.length + ' bytes');
console.log('✓ Dimensions: 512x512');
