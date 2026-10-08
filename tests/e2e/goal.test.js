// The daily goal through the real server: /api/study/today counts practice +
// mock exam + full exam answers of today; the goal is saved on the account.
// Usage: node tests/e2e/goal.test.js http://127.0.0.1:5070
const base = process.argv[2] || process.env.TEST_BASE || 'http://127.0.0.1:5070';
const j = async (path, opts = {}, token) => {
  const res = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const t = await res.text();
  let body; try { body = JSON.parse(t); } catch (e) { body = { text: t.slice(0, 200) }; }
  return { status: res.status, body };
};
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
(async () => {
  const { body: reg } = await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `g${Date.now()}@example.com`, password: 'password123', name: 'בודק' }) });
  const token = reg.token;
  const today = async () => (await j('/api/study/today', {}, token)).body;
  let t = await today();
  check('new account: 0 of 15', t.answered === 0 && t.goal === 15, JSON.stringify(t));
  check('register returns the goal', reg.user && reg.user.dailyGoal === 15, JSON.stringify(reg.user && reg.user.dailyGoal));

  // The goal: only 10/15/20/30.
  let r = await j('/api/auth/me', { method: 'PUT', body: JSON.stringify({ dailyGoal: 7 }) }, token);
  check('goal 7 refused (400)', r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
  r = await j('/api/auth/me', { method: 'PUT', body: JSON.stringify({ dailyGoal: 'abc' }) }, token);
  check('goal "abc" refused', r.status === 400, String(r.status));
  r = await j('/api/auth/me', { method: 'PUT', body: JSON.stringify({ dailyGoal: '20' }) }, token);
  check('goal "20" saved', r.status === 200 && r.body.dailyGoal === 20, JSON.stringify(r.body.dailyGoal));
  r = await j('/api/auth/me', { method: 'PUT', body: JSON.stringify({ name: 'נועם' }) }, token);
  check('saving the name keeps the goal', r.body.dailyGoal === 20 && r.body.name === 'נועם', JSON.stringify(r.body.dailyGoal));
  t = await today();
  check('today follows the goal', t.goal === 20, JSON.stringify(t));

  // Practice: 3 answers on 2 questions.
  const { body: items } = await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: [{ question: 'מה זה טור?', answer: 'סכום', category: 'חדו"א' }, { question: 'מה זה גבול?', answer: 'ערך', category: 'חדו"א' }] }) }, token);
  const ids = (Array.isArray(items) ? items : items.items || []).map(i => i._id || i.id);
  for (const [id, n] of [[ids[0], 1], [ids[1], 2], [ids[0], 3]]) {
    const rv = await j(`/api/study/${id}/review`, { method: 'POST', body: JSON.stringify({ confidence: 'think_so', outcome: n === 2 ? 'missed' : 'got_it', clientId: `c${n}` }) }, token);
    if (rv.status !== 200) console.log('review failed', rv.status, JSON.stringify(rv.body).slice(0, 200));
  }
  t = await today();
  check('3 practice answers', t.answered === 3, JSON.stringify(t));

  // Mock exam: 3 answers, one skipped (blank) -> +2.
  r = await j('/api/study/exam/runs', { method: 'POST', body: JSON.stringify({ course: 'חדו"א', clientRunId: `m${Date.now()}`, answers: [
    { itemId: ids[0], question: 'q1', verdict: 'correct', confidence: 'sure' },
    { itemId: ids[1], question: 'q2', verdict: 'blank' },
    { itemId: ids[1], question: 'q3', verdict: 'wrong', confidence: 'guessing' }] }) }, token);
  if (r.status >= 300) console.log('mock save', r.status, JSON.stringify(r.body).slice(0, 200));
  t = await today();
  // (the same question twice is saved once; a blank one doesn't count - as in a full exam)
  check('mock exam: the answered one counted once, the blank not (3+1)', t.answered === 4, JSON.stringify(t));
  // A mock exam whose answers the AI couldn't check: still answered (+1), blank (+0).
  r = await j('/api/study/exam/runs', { method: 'POST', body: JSON.stringify({ course: 'חדו"א', clientRunId: `m2${Date.now()}`, answers: [
    { itemId: ids[0], question: 'q1', verdict: 'unchecked', confidence: 'think_so' },
    { itemId: ids[1], question: 'q2', verdict: 'blank' }] }) }, token);
  t = await today();
  check('mock exam: unchecked counts, blank not (4+1)', t.answered === 5, JSON.stringify(t));

  // Full exam: written, chosen, "I don't know", not chosen, empty -> +3.
  const { body: ex } = await j('/api/full-exams', { method: 'POST', body: JSON.stringify({ course: 'חדו"א', title: 'מבחן', dontKnowShare: 0.25, questions: [{ n: 1, points: 100, parts: [
    { label: 'א', type: 'open', text: 'הוכיחו', points: 20, answer: 'פתרון' },
    { label: 'ב', type: 'mc', text: 'בחרו', points: 20, options: ['1', '2'], correct: '1', answer: '1' },
    { label: 'ג', type: 'open', text: 'חשבו', points: 20, answer: 'פתרון' },
    { label: 'ד', type: 'open', text: 'הסבירו', points: 20, answer: 'פתרון' },
    { label: 'ה', type: 'open', text: 'נמקו', points: 20, answer: 'פתרון' }] }] }) }, token);
  const exId = ex.id || ex._id;
  r = await j(`/api/full-exams/${exId}/runs`, { method: 'POST', body: JSON.stringify({ clientRunId: `f${Date.now()}`, answers: [
    { q: 0, p: 0, text: 'הוכחה', status: 'graded', points: 10 },
    { q: 0, p: 1, choice: '1', status: 'graded', points: 20 },
    { q: 0, p: 2, dontKnow: true, status: 'graded', points: 0 },
    { q: 0, p: 3, status: 'not_chosen' },
    { q: 0, p: 4, text: '   ', status: 'blank' }] }) }, token);
  const savedRun = r.body;
  check('the exam gives points for "I don\'t know"', savedRun.answers && savedRun.answers.find(a => a.p === 2).dontKnow === true, JSON.stringify(savedRun.answers && savedRun.answers.find(a => a.p === 2)));
  if (r.status >= 300) console.log('full run save', r.status, JSON.stringify(r.body).slice(0, 200));
  t = await today();
  check('full exam: written + chosen + "don\'t know" (5+3)', t.answered === 8, JSON.stringify(t));

  // Deleting a question left blank in a mock exam doesn't take practice answers away.
  const { body: more } = await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: [{ question: 'שאלה שבורה', answer: 'x', category: 'חדו"א' }, { question: 'עוד שבורה', answer: 'y', category: 'חדו"א' }] }) }, token);
  const ids2 = (Array.isArray(more) ? more : more.items || []).map(i => i._id || i.id);
  await j('/api/study/exam/runs', { method: 'POST', body: JSON.stringify({ course: 'חדו"א', clientRunId: `m3${Date.now()}`, answers: ids2.map((id, k) => ({ itemId: id, question: 'q' + k, verdict: 'blank' })) }) }, token);
  const beforeDel = (await today()).answered;
  for (const id of ids2) await j(`/api/study/${id}`, { method: 'DELETE' }, token);
  const afterDel = (await today()).answered;
  check('blank mock answers: not counted, and deleting those questions changes nothing', beforeDel === 8 && afterDel === 8, `${beforeDel} -> ${afterDel}`);

  // Another user's answers don't count.
  const { body: reg2 } = await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `g2${Date.now()}@example.com`, password: 'password123', name: 'אחר' }) });
  const t2 = (await j('/api/study/today', {}, reg2.token)).body;
  check('another account starts at 0', t2.answered === 0, JSON.stringify(t2));
  // Without a token: refused.
  r = await j('/api/study/today');
  check('no token -> 401', r.status === 401, String(r.status));
  // Through the app's channel (the web version's /api/rpc).
  r = await j('/api/rpc/get-study-today', { method: 'POST', body: JSON.stringify({ args: [] }) }, token);
  const viaRpc = r.body.result !== undefined ? r.body.result : r.body;
  check('rpc get-study-today', viaRpc && viaRpc.answered === 8 && viaRpc.goal === 20, JSON.stringify(viaRpc));
  console.log(results.join('\n'));
  console.log(`${results.filter(x => x.startsWith('PASS')).length}/${results.length}`);
  console.log(JSON.stringify({ token }));
})().catch(e => { console.error('E2E FAIL', e); console.log(results.join('\n')); process.exit(1); });
