/* check-undefined.js — find identifiers used but never declared.
 *
 *     node tools/check-undefined.js
 *
 * The parse check says a file is valid JavaScript. It does not say every
 * name in it resolves. After a removal pass, a binding can be left reading a
 * local that no longer exists — the file still parses, and every render then
 * throws ReferenceError. That happened once: `posTerms` was cut from
 * renderValsBase's prelude while two bindings below still read it.
 *
 * This walks build/foxy-app.js and Web/foxy-wallet.js with a real parser,
 * tracks scope, and reports any identifier that is read or assigned without a
 * declaration in any enclosing scope, the class, or the known globals. Exits
 * non-zero if it finds one. The wallet was added after sweepQuote assigned a
 * variable declared only in moveQuote: strict mode threw on every call, and
 * moving a token home had never worked.
 */
'use strict';
const fs = require('fs');
const path = require('path');
// acorn is vendored into tools/ so the check needs no npm install
const acorn = require(fs.existsSync(path.join(__dirname, 'acorn')) ? path.join(__dirname, 'acorn') : 'acorn');

const FILES = [
  path.join(__dirname, '..', 'build', 'foxy-app.js'),
  path.join(__dirname, '..', 'Web', 'foxy-wallet.js'),
];

// the runtime and the page supply these; everything else must be declared
const GLOBALS = new Set([
  'DCLogic', 'StreamableLogic', 'React', 'window', 'document', 'console',
  'navigator', 'localStorage', 'sessionStorage', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'JSON', 'Error', 'TypeError', 'RegExp', 'Map', 'Set', 'WeakMap', 'Symbol',
  'parseFloat', 'parseInt', 'isFinite', 'isNaN', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'Infinity', 'NaN', 'undefined',
  'BigInt', 'Uint8Array', 'ArrayBuffer', 'TextEncoder', 'TextDecoder', 'Proxy', 'Reflect',
  'Intl', 'Event', 'CustomEvent', 'MouseEvent', 'TouchEvent', 'KeyboardEvent',
  'Image', 'Audio', 'AudioContext', 'webkitAudioContext', 'FileReader', 'Blob',
  'URL', 'fetch', 'AbortController', 'atob', 'btoa', 'performance', 'crypto',
  'location', 'history', 'screen', 'getComputedStyle', 'matchMedia', 'ResizeObserver',
  'CashuTS', 'FoxyWallet', 'FoxyGate', 'FoxySend', 'qrcode',
  'arguments', 'this', 'globalThis',
]);

function check(FILE) {
  const src = fs.readFileSync(FILE, 'utf8');
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (e) {
    console.log('FAIL parse of ' + path.basename(FILE) + ': ' + e.message);
    return false;
  }

  // pass 1: collect declarations per scope node
  const declared = new Map();   // scope node -> Set of names
  function declare(scope, name) {
    if (!declared.has(scope)) declared.set(scope, new Set());
    declared.get(scope).add(name);
  }
  function patternNames(p, out) {
    if (!p) return out;
    switch (p.type) {
      case 'Identifier': out.push(p.name); break;
      case 'ObjectPattern': p.properties.forEach(q => patternNames(q.type === 'RestElement' ? q.argument : q.value, out)); break;
      case 'ArrayPattern': p.elements.forEach(e => patternNames(e, out)); break;
      case 'RestElement': patternNames(p.argument, out); break;
      case 'AssignmentPattern': patternNames(p.left, out); break;
    }
    return out;
  }
  const isScope = n => /Function|Program|Block|For|Catch|Switch/.test(n.type) && n.type !== 'FunctionExpression' ? true
    : n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration';

  function walk(node, scopes, cb, parent, key) {
    if (!node || typeof node.type !== 'string') return;
    const own = isScope(node);
    const stack = own ? scopes.concat([node]) : scopes;
    cb(node, stack, parent, key);
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && walk(c, stack, cb, node, k));
      else if (v && typeof v.type === 'string') walk(v, stack, cb, node, k);
    }
  }

  walk(ast, [], (n, scopes) => {
    const scope = scopes[scopes.length - 1];
    if (n.type === 'VariableDeclaration') {
      // var hoists to the nearest function; let/const to the nearest block
      const target = n.kind === 'var'
        ? [...scopes].reverse().find(s => /Function|Program/.test(s.type)) || scope
        : scope;
      n.declarations.forEach(d => patternNames(d.id, []).forEach(nm => declare(target, nm)));
    }
    if (/Function/.test(n.type)) {
      if (n.id && n.type === 'FunctionDeclaration') declare(scopes[scopes.length - 2] || scope, n.id.name);
      if (n.id && n.type === 'FunctionExpression') declare(n, n.id.name);
      n.params.forEach(p => patternNames(p, []).forEach(nm => declare(n, nm)));
    }
    if (n.type === 'ClassDeclaration' && n.id) declare(scope, n.id.name);
    if (n.type === 'CatchClause' && n.param) patternNames(n.param, []).forEach(nm => declare(n, nm));
    if (n.type === 'ImportDeclaration') n.specifiers.forEach(s => declare(scope, s.local.name));
  });

  // pass 2: every identifier read must resolve
  const problems = [];
  walk(ast, [], (n, scopes, parent, key) => {
    if (n.type !== 'Identifier') return;
    const name = n.name;
    if (GLOBALS.has(name)) return;
    // not a reference: a method or property name, a non-computed key, a
    // member name after a dot, a label, or the declaring side of a declaration
    if (parent) {
      const t = parent.type;
      if ((t === 'MethodDefinition' || t === 'PropertyDefinition' || t === 'Property') && key === 'key' && !parent.computed) return;
      if (t === 'MemberExpression' && key === 'property' && !parent.computed) return;
      if (t === 'LabeledStatement' || t === 'BreakStatement' || t === 'ContinueStatement') return;
      if (t === 'VariableDeclarator' && key === 'id') return;
      if ((t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ClassDeclaration') && key === 'id') return;
      if (/Function/.test(t) && key === 'params') return;
      if (t === 'CatchClause' && key === 'param') return;
      if (t === 'ExportSpecifier' || t === 'ImportSpecifier') return;
    }
    for (const s of scopes) if (declared.get(s) && declared.get(s).has(name)) return;
    problems.push({ name, pos: n.start });
  });

  const real = problems;

  const byName = {};
  real.forEach(p => { (byName[p.name] = byName[p.name] || []).push(p.pos); });
  const names = Object.keys(byName).sort();
  if (names.length) {
    for (const nm of names) {
      const line = src.slice(0, byName[nm][0]).split('\n').length;
      console.log(`UNDEFINED ${nm.padEnd(20)} first at line ${line}, ${byName[nm].length} use(s)`);
    }
    console.log(`\n${names.length} undefined identifier(s) in ${path.basename(FILE)}`);
    return false;
  }
  return true;
}

const results = FILES.map(check);
if (results.includes(false)) process.exit(1);
console.log('every identifier resolves in the app class and the wallet');
