'use strict';
/* screen-log.js — every screen the person is shown, written down.
 *
 *     node tests/screen-log.js
 *
 * noteScreen from build/foxy-app.js. A device log that names the screens in
 * order is what turns "the switch screen showed transfer instead" from a
 * report into something the log answers by itself. It must say enough to
 * follow a session, and must not say anything that is anyone's money.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function method(sig) {
  const start = src.indexOf('\n  ' + sig);
  if (start < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start + 3, i + 1);
}
const methods = new Function('return {' + method('noteScreen(prevState) {') + '}')();

const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const said = [];
const realLog = console.log;
function note(state, from, extra) {
  const app = Object.assign({ state: state }, extra || {}, methods);
  said.length = 0;
  console.log = (...a) => said.push(a.join(' '));
  try { app.noteScreen({ screen: from }); } finally { console.log = realLog; }
  return said.join('\n');
}

// ---- it says where you went, and from where ---------------------------
{
  const line = note({ screen: 'switchMint', stack: ['home'] }, 'home');
  check('the line names both screens', /home/.test(line) && /switchMint/.test(line), line);
  check('and it is one line', said.length === 1, said.length + ' lines');
  check('it says how deep the back stack is', /back stack 1/.test(line), line);
}

// ---- the flags that decide which screen is drawn ----------------------
{
  const line = note({ screen: 'switchMint', stack: [], trStep: 'pick', flow: 'send' }, 'transfer');
  check('a stale transfer step is named, since it decides the screen',
    /trStep=pick/.test(line), line);
  check('and so is the flow', /flow=send/.test(line), line);
}
{
  const line = note({ screen: 'confirm', stack: [], recvRail: 'CASHU' }, 'amount');
  check('the receive rail is named', /rail=CASHU/.test(line), line);
}
{
  const line = note({ screen: 'home', stack: [] }, 'confirm', { _blockedKind: 'torConnection' });
  check('an open card is named', /card=torConnection/.test(line), line);
}
{
  const line = note({ screen: 'home', stack: [] }, 'amount');
  check('and nothing is named when nothing is set', !/\|/.test(line), line);
}

// ---- how long the screen was up ---------------------------------------
{
  const app = Object.assign({ state: { screen: 'a', stack: [] } }, methods);
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    app.noteScreen({ screen: 'home' });
    app.state = { screen: 'b', stack: [] };
    app.noteScreen({ screen: 'a' });
  } finally { console.log = realLog; }
  check('the first screen reports no time held', / after 0ms/.test(lines[0]), lines[0]);
  check('and the next reports how long the one before it was up',
    / after \d+ms/.test(lines[1]), lines[1]);
}

// ---- it must not carry anyone's money ---------------------------------
{
  const line = note({
    screen: 'confirm', stack: [],
    amount: '1234.56', invoice: 'lnbc9999n1pdangerous', sendSats: 4242,
    recipient: 'someone@example.com', token: 'cashuBsecretsecret',
    balance: 68444, mint: 'https://mint.minibits.cash/Bitcoin',
  }, 'amount');
  const leaks = ['1234.56', 'lnbc', '4242', 'example.com', 'cashuB', '68444', 'minibits']
    .filter(bad => line.toLowerCase().includes(bad.toLowerCase()));
  check('no amount, invoice, token, contact, balance or mint host reaches the log',
    leaks.length === 0, 'leaked: ' + leaks.join(', ') + ' in ' + line);
}

console.log('\n' + (R.fail ? R.pass + ' passed, ' + R.fail + ' failed' : 'all ' + R.pass + ' screen log checks pass'));
process.exit(R.fail ? 1 : 0);
