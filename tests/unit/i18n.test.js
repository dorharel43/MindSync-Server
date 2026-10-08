// Every English string the screens translate with t('...') has a Hebrew
// entry. The app matches EXACT English text (web/i18n.js), so one changed
// word in the English silently leaves it in English for Hebrew users.
// Loads the real web/i18n.js + web/i18n-he.js with a minimal stand-in for the browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', '..', 'web');
const noop = () => {};
const classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
const root = { classList, lang: '', dir: '', appendChild: noop };
const sandbox = {
  console, setTimeout: noop, clearTimeout: noop,
  localStorage: { getItem: (k) => (/lang/.test(k) ? 'he' : null), setItem: noop, removeItem: noop },
  navigator: { language: 'he-IL', languages: ['he-IL'] },
  location: { reload: noop, search: '', hash: '' },
  document: { documentElement: root, head: root, readyState: 'loading', addEventListener: noop, createElement: () => ({}), title: '' },
  MutationObserver: function () { return { observe: noop, disconnect: noop }; }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['i18n.js', 'i18n-he.js']) vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), sandbox, { filename: f });
const t = sandbox.window.t;
if (!t || sandbox.window.I18N.lang !== 'he') { console.log('FAIL the translation module did not load in Hebrew'); process.exit(1); }

// t('...') / t("...") with a plain literal first argument (template literals
// and variables can't be checked statically).
const files = ['renderer.js', 'ui.js'];
const results = [];
const missing = [];
let checked = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(WEB, f), 'utf8');
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1\s*[,)]/g;
  let m;
  while ((m = re.exec(src))) {
    let s;
    try { s = vm.runInNewContext(m[1] + m[2] + m[1]); } catch (e) { continue; }
    if (!/[A-Za-z]{2}/.test(s)) continue;
    checked += 1;
    if (t(s) === s) missing.push(`${f}:${src.slice(0, m.index).split('\n').length}  ${s.slice(0, 120)}`);
  }
}
results.push(`${missing.length ? 'FAIL' : 'PASS'} every t('...') string has Hebrew (${checked} checked)${missing.length ? ` - ${missing.length} missing:\n  ${[...new Set(missing)].join('\n  ')}` : ''}`);
// A sanity check that the lookup really runs: a known key, and a made-up one.
results.push(`${t('Practice it') === 'לתרגל' && t('zz not a real string zz') === 'zz not a real string zz' ? 'PASS' : 'FAIL'} the lookup itself works`);
console.log(results.join('\n'));
console.log(`${results.filter(r => r.startsWith('PASS')).length}/${results.length}`);
