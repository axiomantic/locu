#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findBinary() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const arch = process.arch;
  const platform = process.platform;

  // 1. Direct binary in bin/ (locu or locutus)
  const locuBin = path.join(__dirname, `locu${ext}`);
  if (fs.existsSync(locuBin)) return locuBin;
  const directBin = path.join(__dirname, `locutus${ext}`);
  if (fs.existsSync(directBin)) return directBin;

  // 2. Platform-arch specific binary
  const platformLocu = path.join(__dirname, `locu-${platform}-${arch}${ext}`);
  if (fs.existsSync(platformLocu)) return platformLocu;
  const platformBin = path.join(__dirname, `locutus-${platform}-${arch}${ext}`);
  if (fs.existsSync(platformBin)) return platformBin;

  // 3. Vendor directory
  const vendorLocu = path.join(__dirname, '..', 'vendor', 'bin', `locu${ext}`);
  if (fs.existsSync(vendorLocu)) return vendorLocu;
  const vendorBin = path.join(__dirname, '..', 'vendor', 'bin', `locutus${ext}`);
  if (fs.existsSync(vendorBin)) return vendorBin;

  return null;
}

const binPath = findBinary();
if (!binPath) {
  console.error(`Error: @axiomantic/locu native binary not found for ${process.platform}-${process.arch}.`);
  console.error(`Please visit https://github.com/axiomantic/locu/releases to download.`);
  process.exit(1);
}

try {
  fs.chmodSync(binPath, 0o755);
} catch (_) {}

const res = spawnSync(binPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env
});

if (res.error) {
  console.error(`Failed to execute locu: ${res.error.message}`);
  process.exit(1);
}

process.exit(res.status !== null ? res.status : (res.signal ? 1 : 0));
