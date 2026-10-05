/**
 * Guards against a UTF-8 BOM in committed sources.
 *
 * PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, which JSON.parse
 * and Next's build both reject: Render failed with
 * `SyntaxError: Unexpected token '\ufeff'` while reading package.json, and the
 * same would happen to any route it parses. Editors do it too, so check on
 * every build rather than discovering it on the deploy host.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const BOM = [0xef, 0xbb, 0xbf];
const hasBom = (buf) => buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);

const offenders = [];
for (const f of files) {
  let buf;
  try {
    buf = fs.readFileSync(f);
  } catch {
    continue;
  }
  if (hasBom(buf)) offenders.push(f);
}

if (offenders.length) {
  console.error(`BOM found in ${offenders.length} file(s):`);
  for (const f of offenders) console.error(`  ${f}`);
  console.error('\nRemove the BOM (first 3 bytes EF BB BF) before committing.');
  process.exit(1);
}
console.log(`lint:bom ok (${files.length} tracked files)`);
