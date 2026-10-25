
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const files = ['escrowEngine.js', 'sellerTrust.js'];

const destinations = [
  path.resolve(here, '../safepay-demo/src/data'),
  path.resolve(here, '../dashboard/src'),
];

for (const file of files) {
  const source = path.join(here, file);

  if (!fs.existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  for (const destination of destinations) {
    fs.mkdirSync(destination, { recursive: true });

    const target = path.join(destination, file);
    fs.copyFileSync(source, target);

    console.log(`Copied ${file} -> ${target}`);
  }
}

console.log('All shared files synced successfully.');
