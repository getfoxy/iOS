// vitest.bundle.config.mjs — run cashu-ts's own node unit tests against Foxy's
// shipped Web/cashu-ts.js instead of cashu-ts's TypeScript source.
//
// Copied into a checkout of cashu-ts v4.11.0 by test-cashu-ts-bundle.sh; it
// imports vitest from that checkout, so it does not run from here.
//
// How: after vitest strips a test file's types, every runtime import that
// resolves into src/ is rewritten name by name. A name the bundle exports is
// taken from the bundle (loaded from the exact bytes Foxy ships); a name it
// does not export (an internal helper the tests reach into) stays on the
// source. The per-file split is written to $BUNDLE_REPORT so the result can
// say how much of each test actually exercised the bundle, together with
// __src_modules_loaded__: every src/ file vitest had to load at all.

import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, configDefaults } from 'vitest/config';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const BUNDLE = process.env.FOXY_BUNDLE;
const REPORT = process.env.BUNDLE_REPORT || path.join(ROOT, 'bundle-report.json');
if (!BUNDLE || !fs.existsSync(BUNDLE)) throw new Error('set FOXY_BUNDLE to Web/cashu-ts.js');

// the export names, read from the bundle itself
const C = new Function(fs.readFileSync(BUNDLE, 'utf8') + '\n;return CashuTS;')();
const NAMES = Object.keys(C).sort();
const SHIM = path.join(ROOT, '.foxy-bundle-shim.mjs');
fs.writeFileSync(
  SHIM,
  `import fs from 'node:fs';\n` +
    `const C = new Function(fs.readFileSync(${JSON.stringify(BUNDLE)}, 'utf8') + '\\n;return CashuTS;')();\n` +
    `export const { ${NAMES.join(', ')} } = C;\n`,
);
const EXPORTED = new Set(NAMES);

const report = {};
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2;?/g;
const IMPORT_NS = /import\s*\*\s*as\s+(\w+)\s+from\s*(["'])([^"']+)\2;?/g;
// anything else that reaches src/ (default, side-effect or dynamic import) is
// left alone and recorded as source
const IMPORT_OTHER = /(?:import\s+[\w$]+\s*(?:,\s*\{[^}]*\})?\s*from\s*|import\s*\(\s*|import\s*)(["'])(\.[^"']*)\1/g;

function intoSrc(importer, spec) {
  if (!spec.startsWith('.')) return false;
  const abs = path.resolve(path.dirname(importer), spec);
  return abs === SRC || abs.startsWith(SRC + path.sep);
}

const redirect = {
  name: 'foxy-bundle-redirect',
  enforce: 'post',
  transform(code, id) {
    const file = id.split('?')[0];
    if (file.startsWith(SRC + path.sep)) {
      (report.__src_modules_loaded__ ||= []).push(path.relative(ROOT, file));
      fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
      return null;
    }
    if (!file.startsWith(path.join(ROOT, 'test') + path.sep)) return null;
    const rel = path.relative(ROOT, file);
    const r = (report[rel] ||= { bundle: [], source: [] });
    let out = code.replace(IMPORT, (whole, list, _q, spec) => {
      if (!intoSrc(file, spec)) return whole;
      const toBundle = [], toSource = [];
      for (const raw of list.split(',').map((s) => s.trim()).filter(Boolean)) {
        const name = raw.split(/\s+as\s+/)[0].trim();
        (EXPORTED.has(name) ? toBundle : toSource).push(raw);
        (EXPORTED.has(name) ? r.bundle : r.source).push(name);
      }
      let s = '';
      if (toBundle.length) s += `import { ${toBundle.join(', ')} } from ${JSON.stringify(SHIM)};`;
      if (toSource.length) s += `import { ${toSource.join(', ')} } from ${JSON.stringify(spec)};`;
      return s;
    });
    out = out.replace(IMPORT_NS, (whole, ns, _q, spec) => {
      if (!intoSrc(file, spec)) return whole;
      const abs = path.resolve(path.dirname(file), spec);
      if (abs === SRC || abs === path.join(SRC, 'index') || abs === path.join(SRC, 'index.ts')) {
        r.bundle.push('* as ' + ns);
        return `import * as ${ns} from ${JSON.stringify(SHIM)};`;
      }
      r.source.push('* as ' + ns + ' (' + spec + ')');
      return whole;
    });
    for (const m of out.matchAll(IMPORT_OTHER)) {
      if (intoSrc(file, m[2]) && !m[0].includes(SHIM)) r.source.push('other import (' + m[2] + ')');
    }
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
    return out === code ? null : { code: out, map: null };
  },
};

export default defineConfig({
  plugins: [redirect],
  test: {
    name: 'node-against-bundle',
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/{auth,integration}.test.ts',
      'test/**.browser.test.ts',
      'test/consumer/**/*.test.ts',
      ...configDefaults.exclude,
    ],
  },
});
