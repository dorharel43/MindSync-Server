// Points per criterion, end to end through the real server (fake Gemini).
// Usage: node tests/e2e/marks.test.js http://127.0.0.1:5070
const base = process.argv[2] || process.env.TEST_BASE || 'http://127.0.0.1:5070';
const j = async (path, opts = {}, token) => {
  const res = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const t = await res.text();
  try { return JSON.parse(t); } catch (e) { return { status: res.status, text: t.slice(0, 200) }; }
};
const rpc = (token, ch, ...args) => j(`/api/rpc/${ch}`, { method: 'POST', body: JSON.stringify({ args }) }, token).then(r => r.result !== undefined ? r.result : r);
const fake = (m) => fetch((process.env.FAKE_GEMINI || 'http://127.0.0.1:9999') + '/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) });
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
(async () => {
  const reg = await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `m${Date.now()}@example.com`, password: 'password123', name: 'בודק' }) });
  const token = reg.token;
  const course = 'חדו"א 2';
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'הרצאה 1', content: 'טורים: מבחן ההשוואה, הטור ההרמוני מתבדר. גבולות: sin(x)/x → 1.', folder: course }) }, token);
  const past = await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'מבחן 2024', content: 'שאלה 1: נכון או לא נכון ... שאלה 2: הוכיחו ...', folder: course }) }, token);
  const wait = async (jobId) => { for (let i = 0; i < 160; i++) { const s = await rpc(token, 'full-exam-job', jobId); if (s.status !== 'running') return s; await new Promise(r => setTimeout(r, 500)); } throw new Error('job timeout'); };
  await fake({ grade: 'ok', check: 'ok' });
  const built = await wait((await rpc(token, 'full-exam-build', { course, pastIds: [String(past._id || past.id)] })).jobId);
  if (built.status !== 'done') throw new Error('build: ' + JSON.stringify(built));
  const examId = built.result.examId;
  const ex = await rpc(token, 'full-exam-get', examId);
  console.log('rubric of 2ב:', JSON.stringify(ex.questions[1].parts[1].rubric));
  const answers = [
    { q: 0, p: 0, choice: 'false', text: 'ההרמוני מתבדר' },   // tf, right verdict, reason required
    { q: 0, p: 1, choice: '1', text: '' },                   // mc auto
    { q: 1, p: 1, choice: '', text: 'הוכחה של רול' }          // open, 3 criteria
  ];
  let n = 0;
  const grade = async (mode, ans = answers) => {
    await fake({ grade: mode });
    const g = await rpc(token, 'full-exam-grade', { examId, answers: ans, startedAt: new Date().toISOString(), usedSec: 60, limitSec: 7200, clientRunId: `run-${mode}-${++n}` });
    const done = await wait(g.jobId);
    if (done.status !== 'done') throw new Error(`grade ${mode}: ` + JSON.stringify(done));
    return done.result.run;
  };
  const row = (run, q, p) => run.answers.find(a => a.q === q && a.p === p);

  // ok: marks per criterion, the total sent (999) ignored - the sum counts.
  let run = await grade('ok');
  let r = row(run, 1, 1);
  check('ok: open part marked per criterion', r.marks.length === 3 && r.points === 20 + 10 + 5, JSON.stringify(r.marks) + ' points ' + r.points);
  check('ok: notes kept, empty on a full criterion', r.marks[0].note === '' && r.marks[1].note === 'חסר שלב בהוכחה');
  let tf = row(run, 0, 0);
  check('ok: tf with a reason marked too', tf.marks.length === 2 && tf.points === 5 + 10, JSON.stringify(tf.marks) + ' ' + tf.points);
  check('ok: mc auto has no marks', row(run, 0, 1).marks.length === 0 && row(run, 0, 1).points === 25);
  check('ok: score adds up', run.score === 25 + 15 + 35, String(run.score));

  // over: a criterion over its points is cut to them.
  run = await grade('over');
  r = row(run, 1, 1);
  check('over: clamped to the criterion', r.marks[0].points === 20 && r.points === 35, JSON.stringify(r.marks));
  // missing: an incomplete list -> the total, no marks.
  run = await grade('missing');
  r = row(run, 1, 1);
  check('missing: falls back to the total', r.marks.length === 0 && r.points === 25, `${r.points} ${JSON.stringify(r.marks)}`);
  // total: the old reply shape still works.
  run = await grade('total');
  r = row(run, 1, 1);
  check('total: old reply shape', r.marks.length === 0 && r.points === 25 && r.status === 'graded', String(r.points));
  // a wrong verdict: 0, and its marks are dropped (they don't add up to 0).
  run = await grade('ok', [{ q: 0, p: 0, choice: 'true', text: 'מתכנס' }]);
  tf = row(run, 0, 0);
  check('wrong verdict: 0 and no marks', tf.points === 0 && tf.marks.length === 0, `${tf.points} ${JSON.stringify(tf.marks)}`);

  // The server doesn't trust the app: marks sent straight to the API.
  const post = (a, id) => j(`/api/full-exams/${examId}/runs`, { method: 'POST', body: JSON.stringify({ answers: a, clientRunId: id }) }, token);
  let saved = await post([{ q: 1, p: 0, status: 'not_chosen' }, { q: 1, p: 1, text: 'x', status: 'graded', points: 50, marks: [{ c: 0, points: 50, note: 'a' }, { c: 1, points: 0 }, { c: 2, points: 5 }] }], 'api1');
  if (!saved.answers) console.log('api1 reply:', JSON.stringify(saved).slice(0, 300));
  r = saved.answers.find(a => a.q === 1 && a.p === 1);
  check('server: a mark over its criterion is cut, points = sum', r.marks[0].points === 20 && r.points === 25, `${r.points} ${JSON.stringify(r.marks)}`);
  saved = await post([{ q: 1, p: 0, status: 'not_chosen' }, { q: 1, p: 1, text: 'x', status: 'graded', points: 40, marks: [{ c: 0, points: 20 }, { c: 0, points: 20 }, { c: 2, points: 0 }] }], 'api2');
  r = saved.answers.find(a => a.q === 1 && a.p === 1);
  check('server: a repeated criterion = no marks, the total', r.marks.length === 0 && r.points === 40, `${r.points} ${JSON.stringify(r.marks)}`);
  saved = await post([{ q: 0, p: 1, choice: '1', status: 'graded', marks: [{ c: 0, points: 25 }] }], 'api3');
  r = saved.answers.find(a => a.q === 0 && a.p === 1);
  check('server: auto-marked mc keeps no marks', !r.marks || r.marks.length === 0, JSON.stringify(r.marks));

  // A scheme scaled to 2 decimals (3.33 x 3): every criterion in full = 10, not 9.99.
  const ex2 = await j('/api/full-exams', { method: 'POST', body: JSON.stringify({ course, title: 'עיגול', questions: [{ n: 1, points: 10, parts: [{ label: 'א', type: 'open', text: 'שאלה', points: 10, answer: 'פתרון', rubric: [{ criterion: 'שלב 1', points: 3.33 }, { criterion: 'שלב 2', points: 3.33 }, { criterion: 'שלב 3', points: 3.34 }] }] }] }) }, token);
  const ex2Id = String(ex2.id || ex2._id);
  const ex2Saved = await j(`/api/full-exams/${ex2Id}`, {}, token);
  console.log('saved rubric:', JSON.stringify(ex2Saved.questions[0].parts[0].rubric));
  const full3 = await j(`/api/full-exams/${ex2Id}/runs`, { method: 'POST', body: JSON.stringify({ clientRunId: 'r3', answers: [{ q: 0, p: 0, text: 'x', status: 'graded', points: 9.99, marks: ex2Saved.questions[0].parts[0].rubric.map((r, c) => ({ c, points: r.points })) }] }) }, token);
  r = full3.answers[0];
  check('rounding: every criterion full = full points', r.points === 10 && full3.percent === 100, `${r.points} ${full3.percent}`);
  check('marks keep their criterion and max', r.marks[0].criterion === 'שלב 1' && r.marks[0].max === ex2Saved.questions[0].parts[0].rubric[0].points, JSON.stringify(r.marks[0]));
  // A late "corrected" check replaces the scheme: the old result keeps its own criteria.
  await j(`/api/full-exams/${ex2Id}/check`, { method: 'PATCH', body: JSON.stringify({ parts: [{ q: 0, p: 0, check: 'corrected', answer: 'פתרון מתוקן', rubric: [{ criterion: 'חדש', points: 10 }] }] }) }, token);
  const runs2 = await j(`/api/full-exams/${ex2Id}/runs`, {}, token);
  const old = (Array.isArray(runs2) ? runs2 : runs2.runs || [])[0];
  check('after a corrected scheme the old marks keep theirs', old && old.answers[0].marks.length === 3 && old.answers[0].marks[1].criterion === 'שלב 2', JSON.stringify(old && old.answers[0].marks));
  // pointsFromAi in the app: 3.33 x 3 in full -> 10
  const H = require('../../rpc/handlers.js').examStages;
  const part3 = { points: 10, rubric: [{ points: 3.33 }, { points: 3.33 }, { points: 3.33 }] };
  const mk = H.marksFromAi(part3, { marks: [{ c: 1, points: 3.33 }, { c: 2, points: 3.33 }, { c: 3, points: 3.33 }] });
  check('app: every criterion full = full points', H.pointsFromAi(part3, {}, mk) === 10, String(H.pointsFromAi(part3, {}, mk)));
  check('app: 0-based reply rejected (falls back)', H.marksFromAi(part3, { marks: [{ c: 0, points: 1 }, { c: 1, points: 1 }, { c: 2, points: 1 }] }) === null);

  // "Check again": an unchecked part graded later gets its marks.
  await fake({ grade: 'fail' });
  const g = await rpc(token, 'full-exam-grade', { examId, answers, startedAt: new Date().toISOString(), usedSec: 60, limitSec: 7200, clientRunId: 'run-fail' });
  const failed = (await wait(g.jobId)).result.run;
  const runId = String(failed.id || failed._id);
  check('fail: part left unchecked', row(failed, 1, 1).status === 'unchecked');
  await fake({ grade: 'ok' });
  const rg = await wait((await rpc(token, 'full-exam-regrade', { examId, runId })).jobId);
  r = row(rg.result.run, 1, 1);
  check('regrade: marks come with it', r.status === 'graded' && r.marks.length === 3 && r.points === 35, JSON.stringify(r));
  console.log(results.join('\n'));
  console.log(JSON.stringify({ examId, runId, token }));
})().catch(e => { console.error('E2E FAIL', e.message); console.log(results.join('\n')); process.exit(1); });
