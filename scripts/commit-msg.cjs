const { readFileSync } = require('node:fs');

const subject = readFileSync(process.argv[2], 'utf8').split(/\r?\n/, 1)[0];
const conventional = /^[a-z]+(?:\([^\r\n)]+\))?!?: .+$/;
if (!conventional.test(subject) && !/^(Merge |Revert ")/.test(subject)) {
  console.error('Use a conventional commit subject, for example: fix: handle failed downloads');
  process.exitCode = 1;
}
