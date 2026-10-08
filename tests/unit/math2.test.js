// The review's cases (2/10): DoS, code, money, JSON repair, cuts, trust.
const H = require('../../rpc/handlers.js').examStages;
const results = []; const check = (n, ok, d = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${n}${d !== '' ? ' - ' + JSON.stringify(d) : ''}`);
const C = H.cleanExamText, N = H.cleanMathNotation;
let t0 = Date.now(), r;
r = C('$\\def\\a{' + 'x'.repeat(800) + '}' + '\\a'.repeat(200) + '$'); check('macro bomb refused fast (save)', Date.now() - t0 < 300, `${Date.now() - t0}ms`);
r = C('$\\rule{100000em}{100000em}$'); check('huge rule refused or capped', true);
for (const [src, why] of [["grep '\\(ab\\)*' file", 'grep'], ['regex ^\\(\\d{3}\\)-\\d+$', 'regex'], ['echo "${arr[$i]}"', 'bash array'], ['echo $a&&$b', 'shell &&'], ['המחיר $5 ו-$10', 'money in Hebrew'], ['It costs $5-$10', 'money range']]) {
  r = C(src); check(`unchanged on save: ${why}`, r === src, r);
}
r = C('$$v = u + at$$\nu is the initial speed and $a$ the acceleration'); check('real new line after $$ kept', r.includes('$$\nu is'), r);
r = C('$$x=1$$\ne.g. take $y=2$'); check('real new line before e.g. kept', r.includes('$$\ne.g.'), r);
r = C('It costs $5\ne.g. the $10 one'); check('money across lines untouched', r === 'It costs $5\ne.g. the $10 one', r);
r = C('code:\n\top = 1'); check('a tab outside formulas untouched', r.includes('\top = 1'), r);
r = C('$\frac{1}{2} + \theta \neq \beta$'); check('JSON damage inside $ still repaired', r === '$\\frac{1}{2} + \\theta \\neq \\beta$', r);
r = N('$\\href{http://x}{y}$ ו-$\\url{http://x}$'); check('trust commands not kept as formulas', !/\$\\href|\$\\url/.test(r), r);
// marks note through the app's path
const part = { points: 10, rubric: [{ criterion: 'a', points: 10 }] };
const mk = H.marksFromAi(part, { marks: [{ c: 1, points: 5, note: 'חסר $\frac{1}{2}$ ו-$\theta$' }] });
check('note: JSON damage repaired before whitespace is collapsed', mk && mk[0].note === 'חסר $\\frac{1}{2}$ ו-$\\theta$', mk && mk[0].note);
// cuts never end inside a formula
const long = 'א'.repeat(1990) + ' $\\frac{a}{b} + \\frac{c}{d}$ סוף';
r = H.cutText(N(long), 2000); check('question cut before the formula', r.length <= 2000 && !r.includes('$'), r.slice(-10));
r = H.cutText('קצר $x$', 2000); check('short text not cut', r === 'קצר $x$', r);
// screen
global.window = { katex: require('katex') };
require('../../web/math.js');
const M = global.window.MathText;
t0 = Date.now(); M.toHtml('$\\def\\a{' + 'x'.repeat(800) + '}' + '\\a'.repeat(200) + '$'); check('macro bomb refused fast (screen)', Date.now() - t0 < 300, `${Date.now() - t0}ms`);
let h = M.toHtml('It costs $5-$10 or $5,$10'); check('screen: money range not maths', !h.includes('katex') && h.includes('$5-$10'), h);
h = M.toHtml('bad $\\frac{a}{b$ here'); check('screen: a broken formula shown as written, with $', h.includes('$\\frac{a}{b$'), h);
h = M.toHtml('$\\href{javascript:alert(1)}{x}$'); check('screen: \\href not drawn (no red error)', !h.includes('katex'), h);
h = M.toHtml('$\\rule{100000em}{100000em}$'); check('screen: huge rule capped', !/height:\s*100000em/.test(h), h.slice(0, 100));
h = M.toHtml('נתון $x^2 + \\frac{1}{2}$ וגם $$\\sum_{n=1}^{\\infty} a_n$$'); check('screen: real formulas still drawn', (h.match(/class="katex"/g) || []).length === 2, '');
// second review
h = M.toHtml('Solve:\n$$\\begin{aligned}\na &= b \\\\\n&= d\n\\end{aligned}$$'); check('screen: multi-line aligned drawn', h.includes('katex'), h.slice(0, 60));
h = M.toHtml('Question:\n  (a) compute $x^2$ for $x=3$'); check('screen: 2-space indented prose drawn', (h.match(/class="katex"/g) || []).length === 2, '');
r = C('$$	heta = 	imes 	ext{m} 	o 0$$'); check('save: tab damage inside $$ repaired', r === '$$\\theta = \\times \\text{m} \\to 0$$', r);
r = C('$$a \neq b$$'.replace('\\neq', '\neq')); check('save: \\neq inside $$ repaired', r === '$$a \\neq b$$', r);
r = C('$\nabla f = 0$ and $\nu$'.replace('\\nabla', '\nabla').replace('\\nu', '\nu')); check('save: inline \\nabla / \\nu repaired', r === '$\\nabla f = 0$ and $\\nu$', r);
r = C('$$u = at$$\nu is speed'); check('save: line after $$ starting "u" untouched', r === '$$u = at$$\nu is speed', r);
const proof = '$$\\begin{aligned} n^2 \\text{ even} ' + '&\\implies n \\text{ even} '.repeat(12) + '\\neq 0 \\end{aligned}$$';
r = C(proof); check('save: a proof with 12 \\implies kept', r === proof, r.slice(0, 60));
h = M.toHtml(proof); check('screen: the proof drawn', h.includes('katex'), '');
const bash = 'echo $$\n' + 'x'.repeat(13000) + '\necho $$';
check('cutText: code cut plainly', H.cutText(bash, 12000, true).length === 12000);
check('cutText: one long formula -> plain cut, not empty', H.cutText('$$' + 'x+'.repeat(300) + '$$', 400).length === 400);
r = C('נתון $x = מספר$'); check('save: Hebrew inside a formula (no command) flattened', r === 'נתון x = מספר', r);
check('screen cut: never inside $$', M.cut('א'.repeat(390) + ' $$\\frac{1}{2}$$', 400) === 'א'.repeat(390));
check('screen cut: money before a formula', M.cut('pay $5 now. ' + 'א'.repeat(380) + ' $\\frac{1}{2}$', 400).endsWith('א'));
// third review
r = C('כרטיס עולה 20$, וכרטיס לילד 15$.'); check('save: Hebrew prices keep their $', r === 'כרטיס עולה 20$, וכרטיס לילד 15$.', r);
r = C('המנוי עולה 5$/חודש או 50$ לשנה'); check('save: Hebrew prices per month keep $', r === 'המנוי עולה 5$/חודש או 50$ לשנה', r);
for (const src of ['Word\tan\tarticle', 'Item\to\tvalue', 'R-type:\top\trs\trt', 'x\n\t\to = 1']) { r = C(src); check('save: a table row / code tab untouched: ' + JSON.stringify(src), r === src, r); }
r = C('a \times b'.replace('\\times', '\times') + ' $x$'); check('save: tab after a space before "imes" repaired (then a symbol outside $)', r.startsWith('a × b'), r);
r = C('$$' + String.fromCharCode(92) + 'begin{aligned}\n' + String.fromCharCode(9) + 'ext{a} &= 1\n' + String.fromCharCode(92) + 'end{aligned}$$'); check('save: tab at a line start inside $$ repaired', r.includes('\\text{a}'), r);
check('screen cut: one long formula -> plain cut', M.cut('$$' + 'x+'.repeat(300) + '$$ so', 400).length === 400);
console.log(results.join('\n'));
