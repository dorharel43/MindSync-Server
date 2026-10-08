const H = require('../../rpc/handlers.js').examStages;
const bs = String.fromCharCode(92), q = '"';
const parse = (t) => JSON.parse(H.extractJsonFromText(t));
const results = []; const check = (n, ok, d = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${n}${d !== '' ? ' - ' + JSON.stringify(d) : ''}`);
let r;
r = parse('{"a":"$' + bs + 'sum_{n=1}^{' + bs + 'infty} ' + bs + 'lim$"}'); check('single backslash LaTeX parses', r.a === '$' + bs + 'sum_{n=1}^{' + bs + 'infty} ' + bs + 'lim$', r.a);
r = parse('{"a":"$' + bs + bs + 'sum$ ' + bs + bs + bs + bs + 'x"}'); check('already doubled stays', r.a === '$' + bs + 'sum$ ' + bs + bs + 'x', r.a);
r = parse('{"a":"line1' + bs + 'nline2 ' + bs + q + 'q' + bs + q + ' ' + bs + 'u05D0 ' + bs + 't"}'); check('valid escapes unchanged', r.a === 'line1\nline2 "q" א \t', r.a);
r = parse('{"a":"' + bs + 'user and ' + bs + 'u12"}'); check('\\u without 4 hex doubled', r.a === bs + 'user and ' + bs + 'u12', r.a);
r = parse('Here is the exam:\n```json\n{"q":[{"t":"$' + bs + 'alpha$"}]}\n```'); check('inside a fenced block', r.q[0].t === '$' + bs + 'alpha$', r);
// full path: parse + cleanExamText (repairJsonTex) for \frac (valid \f escape)
r = parse('{"a":"$' + bs + 'frac{1}{2} + ' + bs + 'sigma$"}'); check('\\frac + \\sigma: parse then cleanExamText repairs \\f', H.cleanExamText(r.a) === '$' + bs + 'frac{1}{2} + ' + bs + 'sigma$', H.cleanExamText(r.a));
console.log(results.join('\n'));
