import { readdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

const modelsDir = join(import.meta.dirname, '..', 'assets', 'models');
const subdirs = ['Buildings', 'Units'];
const files = [];

for (const sub of subdirs) {
  const dir = join(modelsDir, sub);
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.gltf')) files.push(`${sub}/${f}`);
  }
}

files.sort();
const outPath = join(modelsDir, 'manifest.json');
writeFileSync(outPath, JSON.stringify(files, null, 0));
console.log(`Manifest generated: ${files.length} models -> ${outPath}`);
