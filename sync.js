// Copies escrowEngine.js into the mobile app and the dashboard so all three stay identical.
import fs from 'fs';
for (const dir of ['../mobile/src/data', '../dashboard/src']) {
  fs.copyFileSync('escrowEngine.js', `${dir}/escrowEngine.js`);
}
console.log('escrowEngine.js copied to mobile/src/data and dashboard/src');
