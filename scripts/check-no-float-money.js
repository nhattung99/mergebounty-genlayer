// Fails the build if parseFloat / Math.round / Math.floor / Math.ceil
// appear near money identifiers in frontend/src.
// Money identifiers (case-insensitive): reward|amount|payout|refund|balance|wei|gen

const fs = require('fs');
const path = require('path');

const WINDOW = 8;

function resolveSrcDir() {
  const candidates = [
    path.join(__dirname, '..', 'frontend', 'src'),
    path.join(__dirname, 'frontend', 'src'),
    path.join(process.cwd(), 'frontend', 'src'),
    path.join(process.cwd(), 'src')
  ];
  const found = candidates.find((dir) => fs.existsSync(dir));
  if (!found) {
    console.error('[BUILD REJECTED] Could not locate frontend/src for the float-money audit.');
    process.exit(1);
  }
  return found;
}

function getFilesRecursively(dir) {
  let results = [];
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getFilesRecursively(fullPath));
    } else if (file.endsWith('.js') || file.endsWith('.jsx')) {
      results.push(fullPath);
    }
  }
  return results;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function runCheck() {
  console.log('Running prebuild check: auditing frontend for floating-point money math...');
  const targetDir = resolveSrcDir();
  const files = getFilesRecursively(targetDir);
  const floatRegex = /\b(?:parseFloat|Math\.round|Math\.floor|Math\.ceil)\s*\(/;
  const moneyRegex = /reward|amount|payout|refund|balance|wei|gen/i;
  let failed = false;
  let hitCount = 0;

  files.forEach((file) => {
    const relativePath = path.relative(path.join(targetDir, '..', '..'), file);
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (!floatRegex.test(line)) return;
      const start = Math.max(0, index - WINDOW);
      const end = Math.min(lines.length - 1, index + WINDOW);
      const nearby = lines.slice(start, end + 1).join('\n');
      if (moneyRegex.test(line) || moneyRegex.test(nearby)) {
        hitCount += 1;
        failed = true;
        console.error(`[ERROR] Float operation near a monetary identifier in ${relativePath}:${index + 1}`);
        console.error(`  > ${line.trim()}`);
      }
    });
  });

  if (failed) {
    console.error(`[BUILD REJECTED] ${hitCount} floating-point operation(s) detected near monetary variables. Use parseGenToWei / formatWeiToGen.`);
    process.exit(1);
  }
  console.log('[PASS] No floating-point operations detected on monetary variables. Strict BigInt integrity verified.');
  process.exit(0);
}

runCheck();
