const { rmSync } = require('node:fs');
const { resolve, sep } = require('node:path');
const root = resolve(__dirname, '..');
for (const relative of ['cjs', 'client/assets']) {
  const target = resolve(root, relative);
  if (!target.startsWith(root + sep)) throw new Error('Invalid build output path');
  rmSync(target, { recursive: true, force: true });
}
