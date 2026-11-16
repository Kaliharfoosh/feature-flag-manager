// Builds build/lambda.zip: the code Lambda runs.  Usage:  npm run build:lambda
// Contains ONLY what the API needs: backend/ (no tests), package.json and the production
// packages. .env (secrets), frontend/, tests and dev tools are never included.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const stage = path.join(repo, 'build', 'lambda');   // temporary folder, ignored by git
const output = path.join(repo, 'build', 'lambda.zip');

// 1. Copy the backend and package files into a clean folder
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(repo, 'backend'), path.join(stage, 'backend'), {
  recursive: true,
  filter: (src) => !/__tests__|\.test\.js$|\.env/.test(path.basename(src)),
});
['package.json', 'package-lock.json'].forEach((f) => fs.copyFileSync(path.join(repo, f), path.join(stage, f)));

// 2. Install production packages only (no jest, nodemon, supertest)
console.log('Installing production packages...');
execSync('npm ci --omit=dev --no-audit --no-fund --loglevel=error', { cwd: stage, stdio: 'inherit' });

// 3. List every file to include
const files = [];
function collect(p) {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(p).sort()) {
      if (name === '.bin' || name === '.package-lock.json') continue;
      collect(path.join(p, name));
    }
  } else if (stat.isFile()) {
    files.push(p);
  }
}
['backend', 'node_modules', 'package.json'].forEach((name) => collect(path.join(stage, name)));

// 4. Write a standard .zip file (no extra tools needed) - same code as Lab 7's zip-lambda.js
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const parts = [];
const central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(path.relative(stage, file).split(path.sep).join('/'));
  const data = fs.readFileSync(file);
  const packed = zlib.deflateRawSync(data);
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt16LE(0x5021, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  parts.push(local, name, packed);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0x5021, 14);
  entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += local.length + name.length + packed.length;
}
const centralSize = central.reduce((sum, b) => sum + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);

fs.writeFileSync(output, Buffer.concat([...parts, ...central, end]));
const mb = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
console.log(`Created build/lambda.zip (${files.length} files, ${mb} MB). .env is NOT included.`);
