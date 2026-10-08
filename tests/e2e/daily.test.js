// The daily exam question through the real server (fake Gemini).
// Usage: node tests/e2e/daily.test.js http://127.0.0.1:5070
const base = process.argv[2] || process.env.TEST_BASE || 'http://127.0.0.1:5070';
const FAKE = (process.env.FAKE_GEMINI || 'http://127.0.0.1:9999');
const j = async (path, opts = {}, token) => {
  const res = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const t = await res.text();
  let body; try { body = JSON.parse(t); } catch (e) { body = { text: t.slice(0, 200) }; }
  return { status: res.status, body };
};
const rpc = async (token, ch, ...args) => { const r = await j(`/api/rpc/${ch}`, { method: 'POST', body: JSON.stringify({ args }) }, token); return r.body.result !== undefined ? r.body.result : r.body; };
const fake = (m) => fetch(FAKE + '/mode', { method: 'POST', body: JSON.stringify(m) });
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
const course = 'חדו"א 2';
async function newUser(tag) {
  const { body } = await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `d${tag}${Date.now()}@example.com`, password: 'password123', name: 'בודק' }) });
  return body.token;
}
async function deck(token, list) {
  const { body } = await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: list.map(([q, tag]) => ({ question: q, answer: 'x', category: course, skillTag: tag })) }) }, token);
  return (Array.isArray(body) ? body : body.items || []).map(i => i._id || i.id);
}
let n = 0;
const answer = (token, id, right) => j(`/api/study/${id}/review`, { method: 'POST', body: JSON.stringify({ confidence: 'think_so', outcome: right ? 'got_it' : 'missed', clientId: `a${++n}` }) }, token);
const wait = async (token, jobId) => { for (let i = 0; i < 120; i++) { const s = await rpc(token, 'full-exam-job', jobId); if (s.status !== 'running') return s; await new Promise(r => setTimeout(r, 400)); } return { status: 'timeout' }; };

(async () => {
  await fake({ daily: 'ok', check: 'ok', grade: 'ok', fault: 'none' });
  const token = await newUser('a');
  let s = await rpc(token, 'daily-question');
  check('no files: state none', s.state === 'none', JSON.stringify(s));

  await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: course }) }, token);
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'הרצאה 3 - גבולות', content: 'גבול של סדרה: a_n שואפת ל-L אם לכל אפסילון... משפט הסנדוויץ\'. סדרה מונוטונית וחסומה מתכנסת.', folder: course }) }, token);
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'מבחן 2024 מועד א', content: 'שאלה 1 (25 נקודות): הוכיחו שהסדרה a_n = (1+1/n)^n מתכנסת.', folder: course }) }, token);
  const ids = await deck(token, [['גבול 1', 'גבולות'], ['גבול 2', 'גבולות'], ['טור 1', 'טורים'], ['טור 2', 'טורים'], ['נגזרת', 'נגזרות'], ['עוד', 'נגזרות']]);
  await answer(token, ids[0], false); await answer(token, ids[1], false); await answer(token, ids[2], true);
  s = await rpc(token, 'daily-question');
  check('3 answers: locked, 3 of 5', s.state === 'locked' && s.answered === 3 && s.unlockAt === 5, JSON.stringify({ state: s.state, answered: s.answered }));
  check('target: the course with files, the weakest topic', s.target && s.target.course === course && s.target.topic === 'גבולות' && s.target.accuracy === 0, JSON.stringify(s.target));

  // The server refuses a daily question before 5 answers (even sent straight to the API).
  let r = await j('/api/full-exams', { method: 'POST', body: JSON.stringify({ course, daily: true, title: 'x', questions: [{ n: 1, points: 20, parts: [{ label: 'א', type: 'open', text: 'q', points: 20, answer: 'a' }] }] }) }, token);
  check('before 5 answers: 403', r.status === 403, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  const early = await rpc(token, 'daily-question-build');
  const earlyOut = early.jobId ? await wait(token, early.jobId) : early;
  check('building while locked: refused, says why', earlyOut.status === 'error' && /opens after 5 answers/.test(earlyOut.error), JSON.stringify(earlyOut).slice(0, 160));

  await answer(token, ids[3], true); await answer(token, ids[4], false);
  s = await rpc(token, 'daily-question');
  check('5 answers: ready', s.state === 'ready', s.state);

  // A garbage reply: an error, nothing saved, still ready.
  await fake({ daily: 'garbage' });
  let start = await rpc(token, 'daily-question-build');
  let out = await wait(token, start.jobId);
  check('garbage reply: error, nothing saved', out.status === 'error' && /usable question/.test(out.error), JSON.stringify(out).slice(0, 160));
  s = await rpc(token, 'daily-question');
  check('after the error: still ready', s.state === 'ready', s.state);

  // Two questions back: only the first is kept, not a bonus.
  await fake({ daily: 'two' });
  const h0 = (await (await fetch(FAKE + '/hits')).json()).hits;
  start = await rpc(token, 'daily-question-build');
  const again = await rpc(token, 'daily-question-build');   // a second click while it runs: the same job
  check('a second click while writing: the same job', again.jobId === start.jobId, `${start.jobId} / ${again.jobId}`);
  out = await wait(token, start.jobId);
  check('written', out.status === 'done' && out.result && out.result.examId, JSON.stringify(out).slice(0, 160));
  const examId = out.result && out.result.examId;
  const calls = (await (await fetch(FAKE + '/hits')).json()).hits - h0;
  check('2 AI calls (write + check)', calls === 2, String(calls));
  const prompt = (await (await fetch(FAKE + '/last-daily')).json()).prompt;
  check('the prompt: the topic, the material and the past exam', /"גבולות"/.test(prompt) && /משפט הסנדוויץ/.test(prompt) && /PAST EXAMS/.test(prompt) && /\(1\+1\/n\)\^n/.test(prompt), prompt.slice(0, 120));
  const ex = (await j(`/api/full-exams/${examId}`, {}, token)).body;
  check('saved: one question, daily, topic, today', ex.daily === true && ex.questions.length === 1 && ex.questions[0].bonus === false && ex.topic === 'גבולות' && /^\d{4}-\d{2}-\d{2}$/.test(ex.dailyDay) && ex.totalPoints === 20, JSON.stringify({ daily: ex.daily, q: ex.questions.length, topic: ex.topic, day: ex.dailyDay, pts: ex.totalPoints }));
  check('in the style of the past exams', ex.basis === 'past_exams' && ex.pastExamFiles.length === 1, JSON.stringify({ basis: ex.basis, files: ex.pastExamFiles }));
  const list = (await j(`/api/full-exams?course=${encodeURIComponent(course)}`, {}, token)).body;
  check('not in the course\'s exam list', Array.isArray(list) && !list.some(e => e.id === examId), JSON.stringify(list).slice(0, 100));
  s = await rpc(token, 'daily-question');
  check('state written', s.state === 'written' && s.exam && s.exam.id === examId, JSON.stringify(s).slice(0, 160));

  // Once a day: building again returns today's (no AI call); the API refuses a second.
  const h1 = (await (await fetch(FAKE + '/hits')).json()).hits;
  start = await rpc(token, 'daily-question-build');
  out = await wait(token, start.jobId);
  const calls2 = (await (await fetch(FAKE + '/hits')).json()).hits - h1;
  check('building again: today\'s, no AI call', out.status === 'done' && out.result.examId === examId && calls2 === 0, `${out.result && out.result.examId} calls ${calls2}`);
  r = await j('/api/full-exams', { method: 'POST', body: JSON.stringify({ course, daily: true, title: 'x', questions: [{ n: 1, points: 20, parts: [{ label: 'א', type: 'open', text: 'q', points: 20, answer: 'a' }] }] }) }, token);
  check('a second one today: 409', r.status === 409, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  r = await j('/api/full-exams', { method: 'POST', body: JSON.stringify({ course, daily: true, title: 'x', questions: [{ n: 1, points: 10, parts: [{ type: 'open', text: 'q', points: 10, answer: 'a' }] }, { n: 2, points: 10, parts: [{ type: 'open', text: 'q', points: 10, answer: 'a' }] }] }) }, token);
  check('two questions as a daily: 400', r.status === 400, String(r.status));

  // Solving it: graded like a full exam; counted in today's answers.
  const before = (await j('/api/study/today', {}, token)).body.answered;
  await fake({ grade: 'ok' });
  const g = await rpc(token, 'full-exam-grade', { examId, answers: [{ q: 0, p: 0, choice: '', text: 'מחלקים ב-n ומקבלים 1' }, { q: 0, p: 1, choice: '', text: 'ההפרש חיובי' }], startedAt: new Date().toISOString(), usedSec: 300, limitSec: 1200, clientRunId: `daily${Date.now()}` });
  const graded = await wait(token, g.jobId);
  check('graded', graded.status === 'done' && graded.result && graded.result.run, JSON.stringify(graded).slice(0, 200));
  s = await rpc(token, 'daily-question');
  check('state done, with the score', s.state === 'done' && s.run && s.run.outOf === 20, JSON.stringify(s.run));
  const after = (await j('/api/study/today', {}, token)).body.answered;
  check('its 2 parts count in today\'s answers', after === before + 2, `${before} -> ${after}`);

  // A daily question never pushes the full exams out (they're kept apart).
  const user2 = await newUser('b');
  await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: course }) }, user2);
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'הרצאה', content: 'חומר', folder: course }) }, user2);
  for (let i = 0; i < 20; i++) await j('/api/full-exams', { method: 'POST', body: JSON.stringify({ course, title: `מבחן ${i}`, questions: [{ n: 1, points: 100, parts: [{ type: 'open', text: 'q', points: 100, answer: 'a' }] }] }) }, user2);
  const ids2 = await deck(user2, [['q1', 'x'], ['q2', 'x'], ['q3', 'x'], ['q4', 'x'], ['q5', 'x']]);
  for (const id of ids2) await answer(user2, id, true);
  r = await j('/api/full-exams', { method: 'POST', body: JSON.stringify({ course, daily: true, topic: 'x', title: 'יומית', questions: [{ n: 1, points: 20, parts: [{ type: 'open', text: 'q', points: 20, answer: 'a' }] }] }) }, user2);
  const list2 = (await j(`/api/full-exams?course=${encodeURIComponent(course)}`, {}, user2)).body;
  check('the 20 full exams are all still there', r.status === 201 && list2.length === 20, `${r.status} ${list2.length}`);

  // An exam in the Planner soon: that course comes first.
  const user3 = await newUser('c');
  for (const c of ['סטטיסטיקה', course]) {
    await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: c }) }, user3);
    await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'הרצאה', content: 'חומר', folder: c }) }, user3);
  }
  const soonD = new Date(Date.now() + 9 * 86400000);
  const soon = soonD.toISOString().slice(0, 10);
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][soonD.getUTCDay()];
  const ev = await j('/api/events', { method: 'POST', body: JSON.stringify({ title: 'מבחן בסטטיסטיקה', type: 'exam', day, date: soon, time: '09:00' }) }, user3);
  if (ev.status >= 300) console.log('event', ev.status, JSON.stringify(ev.body).slice(0, 200));
  s = await rpc(user3, 'daily-question');
  check('an exam in 9 days: that course, "exam soon"', s.target && s.target.course === 'סטטיסטיקה' && s.target.why === 'exam_soon' && s.target.exam && s.target.exam.daysLeft >= 8, JSON.stringify(s.target));

  // Files not in any course ("No Folder") aren't a course.
  const user4 = await newUser('e');
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'קובץ בלי תיקייה', content: 'חומר' }) }, user4);
  const ids4 = await deck(user4, [['q1', 'x'], ['q2', 'x'], ['q3', 'x'], ['q4', 'x'], ['q5', 'x']]);
  for (const id of ids4) await answer(user4, id, true);
  s = await rpc(user4, 'daily-question');
  check('only unfiled files: state none (not "No Folder")', s.state === 'none', JSON.stringify(s.target));

  // Three saves at the same moment: one passes.
  const user5 = await newUser('f');
  await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: course }) }, user5);
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'הרצאה', content: 'חומר', folder: course }) }, user5);
  const ids5 = await deck(user5, [['q1', 'x'], ['q2', 'x'], ['q3', 'x'], ['q4', 'x'], ['q5', 'x']]);
  for (const id of ids5) await answer(user5, id, true);
  const body = JSON.stringify({ course, daily: true, topic: 'x', title: 'יומית', questions: [{ n: 1, points: 20, parts: [{ type: 'open', text: 'q', points: 20, answer: 'a' }] }] });
  const codes = (await Promise.all([1, 2, 3].map(() => j('/api/full-exams', { method: 'POST', body }, user5)))).map(x => x.status).sort();
  check('3 saves at once: one 201, two 409', JSON.stringify(codes) === '[201,409,409]', JSON.stringify(codes));

  // Yesterday's question, never answered: it waits (written) until it is.
  const mongoose = require('mongoose');
  await mongoose.connect('mongodb://127.0.0.1:27017/' + (process.env.TEST_DB || 'mindsync_tt2'));
  const FE = mongoose.connection.collection('fullexams');
  const ystr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const mine = await FE.findOne({ daily: true, title: 'יומית' }, { sort: { createdAt: -1 } });
  await FE.updateOne({ _id: mine._id }, { $set: { dailyDay: ystr, createdAt: new Date(Date.now() - 86400000) } });
  await mongoose.connection.collection('dailyclaims').deleteMany({ _id: { $regex: ':' } , day: { $ne: ystr } });
  s = await rpc(user5, 'daily-question');
  check('yesterday\'s unanswered question waits (written)', s.state === 'written' && s.exam && s.exam.id === String(mine._id), JSON.stringify({ state: s.state, exam: s.exam && s.exam.id }));
  await rpc(user5, 'full-exam-grade', { examId: String(mine._id), answers: [{ q: 0, p: 0, choice: '', text: 'תשובה' }], startedAt: new Date().toISOString(), usedSec: 60, limitSec: 600, clientRunId: `y${Date.now()}` }).then(g => wait(user5, g.jobId));
  s = await rpc(user5, 'daily-question');
  check('answered: today\'s can be written (ready)', s.state === 'ready', s.state);
  // Reset all data / delete the question / delete the account: no claim is left behind.
  const DC = mongoose.connection.collection('dailyclaims');
  const user6 = await newUser('g');
  const setup6 = async () => {
    await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: course }) }, user6);
    await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'הרצאה', content: 'חומר', folder: course }) }, user6);
    const ids6 = await deck(user6, [['q1', 'x'], ['q2', 'x'], ['q3', 'x'], ['q4', 'x'], ['q5', 'x']]);
    for (const id of ids6) await answer(user6, id, true);
  };
  await setup6();
  let saved6 = await j('/api/full-exams', { method: 'POST', body }, user6);
  await j('/api/admin/hard-reset', { method: 'POST' }, user6);
  await setup6();
  r = await j('/api/full-exams', { method: 'POST', body }, user6);
  check('after "reset all data": today\'s can be written again', saved6.status === 201 && r.status === 201, `${saved6.status} ${r.status}`);
  const id6 = r.body.id || r.body._id;
  await j(`/api/full-exams/${id6}`, { method: 'DELETE' }, user6);
  r = await j('/api/full-exams', { method: 'POST', body }, user6);
  check('after deleting today\'s question: it can be written again', r.status === 201, String(r.status));
  const me6 = (await j('/api/auth/me', {}, user6)).body;
  const del = await j('/api/auth/me', { method: 'DELETE', body: JSON.stringify({ password: 'password123' }) }, user6);
  const left = await DC.countDocuments({ userId: new mongoose.Types.ObjectId(String(me6.id)) });
  check('account deleted: no claim left', del.status === 200 && left === 0, `${del.status} claims ${left}`);
  await mongoose.disconnect();

  console.log(results.join('\n'));
  console.log(`${results.filter(x => x.startsWith('PASS')).length}/${results.length}`);
  await fake({ daily: 'ok' });
})().catch(e => { console.error('E2E FAIL', e); console.log(results.join('\n')); process.exit(1); });
