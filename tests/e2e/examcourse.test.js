// Which course an exam is (18/10): the course the student picked for it, or
// the one course its title named, decides - the title is read only for an
// exam that knows no course. Before, the pick was saved but nothing read it.
// Usage: node tests/e2e/examcourse.test.js http://127.0.0.1:5070
const base = process.argv[2] || process.env.TEST_BASE || 'http://127.0.0.1:5070';
const j = async (path, opts = {}, token) => {
  const res = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const t = await res.text();
  let body; try { body = JSON.parse(t); } catch (e) { body = { text: t.slice(0, 200) }; }
  return { status: res.status, body };
};
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const inDays = (n) => { const d = new Date(Date.now() + n * 86400000); return { date: d.toISOString().slice(0, 10), day: DAYS[d.getUTCDay()] }; };
const CALC = 'חדו"א 2', STATS = 'סטטיסטיקה';

(async () => {
  const { body: reg } = await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `exc${Date.now()}@example.com`, password: 'password123', name: 'בודקת' }) });
  const token = reg.token;
  const calc = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: CALC }) }, token)).body;
  const stats = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: STATS }) }, token)).body;
  await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: [
    ...[1, 2, 3].map(i => ({ question: `טור ${i}`, answer: 'x', category: CALC, skillTag: 'טורים' })),
    ...[1, 2, 3].map(i => ({ question: `התפלגות ${i}`, answer: 'x', category: STATS, skillTag: 'התפלגות' }))] }) }, token);
  const examOf = async (course) => {
    const s = (await j('/api/study/stats', {}, token)).body;
    const sub = (s.subjects || []).find(x => x.category === course);
    return sub ? sub.exam : undefined;
  };
  const event = async (title, n) => (await j('/api/events', { method: 'POST', body: JSON.stringify({ title, type: 'exam', time: '09:00', ...inDays(n) }) }, token)).body;
  const pick = (id, courseId) => j(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify({ courseId }) }, token);

  // 1. A title that names no course: no course's exam - until the student picks one.
  const e1 = await event('מבחן סוף סמסטר', 10);
  check('an exam naming no course belongs to none', (await examOf(CALC)) === null && (await examOf(STATS)) === null, JSON.stringify(e1).slice(0, 120));
  let r = await pick(e1._id, calc._id);
  let ex = await examOf(CALC);
  check('picked for חדו"א 2: it is that course\'s exam (date and days left)', r.status === 200 && ex && ex.date === inDays(10).date && ex.daysLeft >= 9, JSON.stringify([r.status, ex]));
  check('...and not the other course\'s', (await examOf(STATS)) === null);

  // 2. A title that names one course, picked for another: the pick wins.
  const e2 = await event(`מבחן ב${STATS}`, 5);
  check('a title naming a course links it (as before)', ((await examOf(STATS)) || {}).date === inDays(5).date);
  await pick(e2._id, calc._id);
  ex = await examOf(CALC);
  check('picked for another course: it moves there (the nearer exam now)', ex && ex.date === inDays(5).date && (await examOf(STATS)) === null, JSON.stringify([ex, await examOf(STATS)]));

  // 3. "Not a course exam": a title naming a course doesn't bring it back.
  await pick(e2._id, null);
  ex = await examOf(STATS);
  check('"not a course exam" (picked, no course): no course takes it by its title', ex === null && ((await examOf(CALC)) || {}).date === inDays(10).date, JSON.stringify([ex, await examOf(CALC)]));

  // 3b. "Not a course exam" for an exam that had no course yet (stored null):
  // with coursePicked it counts - it isn't asked again - and without it (the
  // app's echo after a Google sync) nothing changes.
  const e3 = await event('בוחן אמצע', 20);
  let g = (await j(`/api/events/${e3._id}`, { method: 'PUT', body: JSON.stringify({ courseId: null }) }, token)).body;
  check('the echo of a null course (no coursePicked) changes nothing', g.courseId === null && !g.coursePicked, JSON.stringify([g.courseId, g.coursePicked]));
  g = (await j(`/api/events/${e3._id}`, { method: 'PUT', body: JSON.stringify({ courseId: null, coursePicked: true }) }, token)).body;
  check('"not a course exam" for an exam with no course yet is kept (coursePicked)', g.courseId === null && g.coursePicked === true, JSON.stringify([g.courseId, g.coursePicked]));

  // 4. The course renamed: its exam stays with it (the link is by id).
  await j(`/api/folders/${calc._id}`, { method: 'PUT', body: JSON.stringify({ name: 'חשבון אינפיניטסימלי 2' }) }, token);
  ex = await examOf('חשבון אינפיניטסימלי 2');
  check('the course renamed: its picked exam goes with it', ex && ex.date === inDays(10).date, JSON.stringify(ex));

  // 5. Through the app's own actions (the browser calls these).
  const rpc = async (ch, ...args) => { const r = await j(`/api/rpc/${ch}`, { method: 'POST', body: JSON.stringify({ args }) }, token); return r.body.result !== undefined ? r.body.result : r.body; };
  const e4 = await event('בוחן חוזר', 3);
  let res = await rpc('set-event-course', e4._id, stats._id);
  check('set-event-course: the exam is that course\'s (picked)', String(res.courseId) === String(stats._id) && res.coursePicked === true && ((await examOf(STATS)) || {}).date === inDays(3).date, JSON.stringify([res.courseId, res.coursePicked]));
  res = await rpc('set-event-course', e4._id, null);
  check('set-event-course(null): "not a course exam" kept', res.courseId === null && res.coursePicked === true && (await examOf(STATS)) === null, JSON.stringify([res.courseId, res.coursePicked]));
  // A syllabus imported for a course: its exam is that course's, whatever its title says.
  res = await rpc('import-syllabus-items', [{ kind: 'exam', title: 'מועד א', date: inDays(7).date, time: '09:00' }], { course: STATS, courseId: String(stats._id) });
  const imported = (await j('/api/events', {}, token)).body.find(e => e.title && e.title.includes('מועד א'));
  // (coursePicked: the id was SENT - its title, "מועד א - סטטיסטיקה", would link it by name anyway)
  check('syllabus import with a course: the exam is linked to it by id', imported && String(imported.courseId) === String(stats._id) && imported.coursePicked === true && ((await examOf(STATS)) || {}).date === inDays(7).date, JSON.stringify([res && res.errors, imported && imported.courseId, imported && imported.coursePicked]));

  // 6. A later picked exam doesn't hide a nearer one the title names: "מבחן
  // בחדו"א" (no number - linked by no one at save) is the only course of its
  // name's, so it is the renamed course's... use a fresh course for this.
  const alg = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'אלגברה ב' }) }, token)).body;
  await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: [1, 2].map(i => ({ question: `מטריצה ${i}`, answer: 'x', category: 'אלגברה ב', skillTag: 'מטריצות' })) }) }, token);
  const far = await event('בוחן סיום', 30);
  await pick(far._id, alg._id);
  await event('מבחן באלגברה', 2);   // no letter: linked at save to no course; by title only when alone
  ex = await examOf('אלגברה ב');
  check('a nearer exam its title names beats a later picked one', ex && ex.date === inDays(2).date, JSON.stringify(ex));

  console.log(results.join('\n'));
  console.log(`${results.filter(x => x.startsWith('PASS')).length}/${results.length}`);
})().catch(err => { console.log(results.join('\n')); console.log('FAIL the test crashed:', err.message); process.exit(1); });
