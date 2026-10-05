// summarize-bundle-tests.js <checkout> <vitest json> <bundle-report.json>
//
// Splits the bundle run's results by how much of each test file could be
// pointed at Web/cashu-ts.js:
//
//   A  every cashu-ts name it imports came from the bundle
//   B  as A, but the test also imports @noble/@scure itself and hands those
//      objects to the bundle, which carries its own copy of those libraries
//   C  some names are internal (not exported by the package), so they still
//      come from src/ — source and bundle classes meet in one test
//
// Failures in B and C can be the harness (instanceof across two copies of a
// class, vi.spyOn on a module the bundle never calls into) rather than the
// bundle. Failures in A cannot.
const fs = require('fs');
const path = require('path');
const [checkoutArg, resultsPath, reportPath] = process.argv.slice(2);
const checkout = fs.realpathSync(checkoutArg); // vitest reports real paths
const res = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

const cats = { A: [0, 0, 0, []], B: [0, 0, 0, []], C: [0, 0, 0, []] };
for (const tr of res.testResults) {
  const rel = path.relative(checkout, tr.name);
  const r = report[rel] || { bundle: [], source: [] };
  const src = fs.readFileSync(tr.name, 'utf8');
  const n = tr.assertionResults.length;
  const failed = tr.assertionResults.filter((a) => a.status === 'failed').length;
  const c = r.source.length || !r.bundle.length ? 'C' : /from '@(noble|scure)\//.test(src) ? 'B' : 'A';
  cats[c][0]++; cats[c][1] += n; cats[c][2] += failed;
  if (failed) cats[c][3].push(`${rel} (${failed})`);
  if (c === 'A') console.log('A-FILE ' + rel); // read by test-cashu-ts-bundle.sh
}
const label = {
  A: 'bundle only',
  B: 'bundle + @noble/@scure objects from node_modules',
  C: 'bundle + internal names from src/',
};
console.log(`        total ${res.numTotalTests}, passed ${res.numPassedTests}, failed ${res.numFailedTests}`);
for (const k of ['A', 'B', 'C']) {
  const [files, tests, failed, list] = cats[k];
  console.log(`        ${k} ${label[k].padEnd(50)} ${files} files, ${tests} tests, ${failed} failed`);
  for (const l of list) console.log(`            ${l}`);
}
process.exit(cats.A[2] ? 1 : 0);
