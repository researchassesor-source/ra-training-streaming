const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'release');
const outFile = path.join(outDir, `ra-training-streaming-source-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
const excludedDirs = new Set(['.git', 'node_modules', '.local-data', '.local-runtime', '.tools', 'logs', 'release']);
const excludedFiles = new Set(['.DS_Store']);
const excludedExtensions = new Set(['.log', '.tmp']);

function shouldExclude(name, relativePath) {
  if (excludedDirs.has(name) || excludedFiles.has(name)) return true;
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true;
  if (excludedExtensions.has(path.extname(name).toLowerCase())) return true;
  if (/credential|secret|token/i.test(relativePath) && !/\.example$/i.test(relativePath)) return true;
  return false;
}

function collectFiles(dir = root, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (shouldExclude(entry.name, relativePath)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(fullPath, relativePath));
    else if (entry.isFile()) files.push({ fullPath, relativePath: relativePath.replace(/\\/g, '/') });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
}

const crcTable = makeCrc32Table();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function createZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = fs.readFileSync(file.fullPath);
    const name = Buffer.from(file.relativePath, 'utf8');
    const stat = fs.statSync(file.fullPath);
    const { dosTime, dosDate } = dosDateTime(stat.mtime);
    const checksum = crc32(data);
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate),
      u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name,
    ]);
    chunks.push(localHeader, data);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate),
      u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += localHeader.length + data.length;
  }
  const centralStart = offset;
  const centralDirectory = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralDirectory.length), u32(centralStart), u16(0),
  ]);
  return Buffer.concat([...chunks, centralDirectory, end]);
}

fs.mkdirSync(outDir, { recursive: true });
const files = collectFiles();
fs.writeFileSync(outFile, createZip(files));
console.log(`Source package created: ${path.relative(root, outFile)} (${files.length} files)`);
