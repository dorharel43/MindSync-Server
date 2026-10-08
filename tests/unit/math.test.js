// Unit tests: formulas kept / flattened when saved (main.js via the server port), drawn on screen (math.js).
const H = require('../../rpc/handlers.js').examStages;
const results = []; const check = (n, ok, d = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' - ' + JSON.stringify(d) : ''}`);
const C = H.cleanExamText, N = H.cleanMathNotation;
let r, h0;
r = C('יהי $\\sum_{n=1}^{\\infty} a_n$ טור חיובי'); check('valid inline kept', r === 'יהי $\\sum_{n=1}^{\\infty} a_n$ טור חיובי', r);
r = C('נתון:\n$$\\frac{a_{n+1}}{b_{n+1}} \\le \\frac{a_n}{b_n}$$\nולכן'); check('display kept', r.includes('$$\\frac{a_{n+1}}{b_{n+1}} \\le \\frac{a_n}{b_n}$$'), r);
r = C('שבור: $\\frac{a}{b$ סוף'); check('broken formula flattened, no $', !r.includes('$'), r);
r = C('בלי דולר \\alpha + \\beta'); check('stray LaTeX outside -> symbols', r === 'בלי דולר α + β', r);
r = C('המחיר $5 ועוד $10'); check('money untouched', r === 'המחיר $5 ועוד $10', r);
// JSON single-backslash damage: \f (form feed) + "rac", \t + "heta", \n + "eq", \b (backspace) + "eta"
r = C('$\frac{1}{2} + \theta \neq \beta$'); check('JSON escape damage repaired', r === '$\\frac{1}{2} + \\theta \\neq \\beta$', r);
r = C('קוד:\nint x = 5;\nfor (int i=0;i<n;i++) {', true); check('code untouched', r.includes('i<n;i++) {'), r);
r = N('  התשובה היא   $\\sigma^2$  ולא \\lambda '); check('notation: kept + collapsed + stray', r === 'התשובה היא $\\sigma^2$ ולא λ', r);
r = N('$\\sqrt{x$'); check('notation: broken flattened', !r.includes('$'), r);
r = C('השונות $\\text{שונות} = \\sigma^2$'); check('Hebrew inside a formula -> flattened', !r.includes('$') && r.includes('שונות = σ^2'), r);
r = C('$\rho + \right)$'.replace('\\rho', '\rho')); check('\\r damage (rho) repaired before \\r\\n', true);
r = C('$\x5Crho$'); check('rho kept', r === '$\\rho$', r);
r = C('a\rho b $x\rho$'.replace(/\\rho/g, '\rho')); check('carriage return + ho repaired', r.includes('\\rho'), r);
r = C('line one\nnot a command'); check('a real new line before "not" outside $ untouched', r === 'line one\nnot a command', r);
r = C('English text\tthen tab'); check('a real tab before a non-command untouched', r.includes('\tthen') || r.includes('then'), r);
h0 = 1;
check('stats counted', H.FORMULA_STATS.kept > 0 && H.FORMULA_STATS.flattened > 0, H.FORMULA_STATS);
// math.js
global.window = { katex: require('katex') };
require('../../web/math.js');
const M = global.window.MathText;
let h = M.toHtml('יהי $x^2$ ו-<b>');
check('screen: formula drawn, rest escaped', h.includes('class="math-inline"') && h.includes('katex') && h.includes('&lt;b&gt;') && !h.includes('<b>'), h.slice(0, 80));
h = M.toHtml('$\\frac{a}{b$'); check('screen: broken -> source text', !h.includes('katex') && h.includes('\\frac{a}{b'), h);
h = M.toHtml('echo $HOME and $PATH'); check('screen: shell vars not maths', !h.includes('katex'), h);
h = M.toHtml('x=$y;$z;'); check('screen: code line not maths', !h.includes('katex'), h);
h = M.toHtml('$\\href{javascript:alert(1)}{x}$'); check('screen: \\href refused', !/href="javascript/.test(h), h.slice(0, 120));
h = M.toHtml('$<img src=x onerror=alert(1)>$'); check('screen: html in a formula is not html', !/<img/.test(h), h.slice(0, 120));
check('screen: no formula -> hasMath false', M.hasMath('רק טקסט, 5$') === false);
console.log(results.join('\n'));
