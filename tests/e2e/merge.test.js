// One course into another (23/10): everything of it moves - files,
// questions, mock exams, full exams and their results, exam events, the exam
// map, its tasks' label - also what carries only its name; then it is deleted.
// Usage: node tests/e2e/merge.test.js http://127.0.0.1:5070
const base = process.argv[2] || process.env.TEST_BASE || 'http://127.0.0.1:5070';
const mongoose = require('mongoose');
const j = async (path, opts = {}, token) => {
  const res = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const t = await res.text();
  let body; try { body = JSON.parse(t); } catch (e) { body = { text: t.slice(0, 200) }; }
  return { status: res.status, body };
};
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
const idOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
const same = (a, b) => a != null && b != null && String(a) === String(b);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const inDays = (n) => { const d = new Date(Date.now() + n * 86400000); return { date: d.toISOString().slice(0, 10), day: DAYS[d.getUTCDay()] }; };

(async () => {
  await mongoose.connect(`${(process.env.TEST_MONGO || 'mongodb://127.0.0.1:27017').replace(/\/$/, '')}/${process.env.TEST_DB || 'mindsync_tt3'}`);
  const db = mongoose.connection.db;
  const reg = async (tag) => (await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `mrg${tag}${Date.now()}@example.com`, password: 'password123', name: 'בודקת' }) })).body.token;
  const token = await reg('a');
  const other = await reg('b');
  const uid = new mongoose.Types.ObjectId(idOf(token));
  const FROM = 'מבוא לסטטיסטיקה', INTO = 'סטטיסטיקה';
  const from = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: FROM }) }, token)).body;
  const into = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: INTO }) }, token)).body;
  const fid = new mongoose.Types.ObjectId(String(from._id)), iid = new mongoose.Types.ObjectId(String(into._id));
  const now = new Date();

  // Everything of FROM: by id (through the API), and by name only (old records).
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'הרצאה 1.pdf', content: 'x', folder: FROM }) }, token);
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'מבחן 2024.pdf', content: 'x', folder: FROM, role: 'past_exam' }) }, token);
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'הרצאה של היעד.pdf', content: 'x', folder: INTO }) }, token);
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'מבחן 2023 של היעד.pdf', content: 'x', folder: INTO, role: 'past_exam' }) }, token);
  await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: [1, 2, 3].map(i => ({ question: `ממקור ${i}`, answer: 'x', category: FROM, skillTag: 'התפלגות' })) }) }, token);
  await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: [{ question: 'מהיעד', answer: 'x', category: INTO, skillTag: 'ממוצע' }] }) }, token);
  await db.collection('studyitems').insertOne({ userId: uid, question: 'ישנה, רק בשם', answer: 'x', category: FROM, courseId: null, suspended: false, mode: 'recall', skillTag: 't', dueDate: now, interval: 0, repetitions: 0, easeFactor: 2.5, reviews: [], createdAt: now });
  await db.collection('examruns').insertOne({ userId: uid, course: FROM, courseId: fid, clientRunId: 'r1', startedAt: now, finishedAt: now, answers: [], score: 70 });
  const fe = await db.collection('fullexams').insertOne({ userId: uid, course: FROM, courseId: fid, title: 'מבחן מלא', questions: [], createdAt: now });
  await db.collection('fullexamruns').insertOne({ userId: uid, examId: fe.insertedId, course: FROM, courseId: fid, clientRunId: 'fr1', startedAt: now, finishedAt: now });
  await db.collection('courseprofiles').insertOne({ userId: uid, course: FROM, courseId: fid, recurring: [{ topic: 'מקור', count: 2, of: 2 }], pastExams: ['a', 'b'], links: [], linkedSkills: [], createdAt: now });
  await db.collection('courseprofiles').insertOne({ userId: uid, course: INTO, courseId: iid, recurring: [{ topic: 'יעד', count: 2, of: 2 }], pastExams: ['c', 'd'], links: [], linkedSkills: [], createdAt: now });
  const ex = (await j('/api/events', { method: 'POST', body: JSON.stringify({ title: 'מבחן סוף סמסטר', type: 'exam', time: '09:00', courseId: String(from._id), ...inDays(10) }) }, token)).body;
  await db.collection('tasks').insertOne({ userId: uid, title: 'תרגיל 3', category: FROM, status: 'open', createdAt: now });
  // a file that carries only the name (old)
  await db.collection('fileitems').insertOne({ userId: uid, name: 'ישן.pdf', content: 'x', folder: FROM, courseId: null, role: 'material', createdAt: now });
  // an exam whose title named both courses - so neither (not asked yet)
  const both = (await j('/api/events', { method: 'POST', body: JSON.stringify({ title: 'מבחן בסטטיסטיקה', type: 'exam', time: '09:00', ...inDays(20) }) }, token)).body;
  check('setup: an exam naming both courses is linked to neither', both.courseId === null, JSON.stringify(both.courseId));

  // ---- refused merges
  let r = await j(`/api/folders/${from._id}/merge`, { method: 'POST', body: JSON.stringify({ into: from._id }) }, token);
  check('merge into itself: refused', r.status === 400, String(r.status));
  const theirs = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'של מישהו אחר' }) }, other)).body;
  r = await j(`/api/folders/${from._id}/merge`, { method: 'POST', body: JSON.stringify({ into: theirs._id }) }, token);
  check('merge into another student\'s course: refused', r.status === 400, String(r.status));
  r = await j(`/api/folders/${from._id}/merge`, { method: 'POST', body: JSON.stringify({ into: into._id }) }, other);
  check('another student can\'t merge my course', r.status === 404, String(r.status));
  check('...and nothing moved meanwhile', (await db.collection('studyitems').countDocuments({ userId: uid, category: FROM })) === 4);

  // ---- the merge
  r = await j(`/api/folders/${from._id}/merge`, { method: 'POST', body: JSON.stringify({ into: into._id }) }, token);
  check('merge: done', r.status === 200 && r.body.success, JSON.stringify(r.body).slice(0, 200));
  const folders = (await j('/api/folders', {}, token)).body;
  check('the merged course is gone, the target stays', folders.length === 1 && folders[0].name === INTO, JSON.stringify(folders.map(f => f.name)));
  const files = await db.collection('fileitems').find({ userId: uid }).toArray();
  check('files: all in the target (name and id) - the old name-only one too', files.length === 5 && files.every(f => f.folder === INTO && same(f.courseId, iid)), JSON.stringify(files.map(f => [f.name, f.folder])));
  const qs = await db.collection('studyitems').find({ userId: uid }).toArray();
  check('questions: all in the target - the old one by name too', qs.length === 5 && qs.every(q => q.category === INTO && same(q.courseId, iid)), JSON.stringify(qs.map(q => [q.question, q.category, String(q.courseId)])));
  const run = await db.collection('examruns').findOne({ userId: uid });
  const full = await db.collection('fullexams').findOne({ userId: uid });
  const frun = await db.collection('fullexamruns').findOne({ userId: uid });
  check('mock exam history, full exam and its result: moved', run.course === INTO && same(run.courseId, iid) && full.course === INTO && same(full.courseId, iid) && frun.course === INTO && same(frun.courseId, iid));
  const profiles = await db.collection('courseprofiles').find({ userId: uid }).toArray();
  check('exam maps: both had one - the target\'s kept, the other dropped', profiles.length === 1 && profiles[0].course === INTO && profiles[0].recurring[0].topic === 'יעד', JSON.stringify(profiles.map(p => [p.course, p.recurring[0].topic])));
  const evNow = await db.collection('events').findOne({ _id: new mongoose.Types.ObjectId(String(ex._id)) });
  check('the exam event: now the target\'s (still picked)', same(evNow.courseId, iid) && evNow.coursePicked === true, JSON.stringify([evNow.courseId, evNow.coursePicked]));
  const bothNow = await db.collection('events').findOne({ _id: new mongoose.Types.ObjectId(String(both._id)) });
  check('the exam that named both courses: with one left, linked to it', same(bothNow.courseId, iid) && !bothNow.coursePicked, JSON.stringify([bothNow.courseId, bothNow.coursePicked]));
  const task = await db.collection('tasks').findOne({ userId: uid, title: 'תרגיל 3' });
  check('its task carries the target\'s name', task.category === INTO, task.category);
  const stats = (await j('/api/study/stats', {}, token)).body;
  const sub = (stats.subjects || []).find(s => s.category === INTO);
  check('Study: the target has all the questions and the exam', sub && sub.items === 5 && sub.exam && sub.exam.date === inDays(10).date && !(stats.subjects || []).some(s => s.category === FROM), JSON.stringify(sub && [sub.items, sub.exam]));
  const map = (await j('/api/rpc/exam-map', { method: 'POST', body: JSON.stringify({ args: [INTO] }) }, token)).body.result;
  // (the kept map read "c, d"; the course's past exams are now both courses' two)
  check('exam map: its past exams changed - it offers a new analysis', !!map && map.pastExams === 2 && map.changed === true, JSON.stringify(map).slice(0, 160));

  // ---- the only exam map moves; a second merge of a gone course
  const c = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'לוגיקה א' }) }, token)).body;
  const d = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'לוגיקה' }) }, token)).body;
  await db.collection('courseprofiles').insertOne({ userId: uid, course: 'לוגיקה א', courseId: new mongoose.Types.ObjectId(String(c._id)), recurring: [{ topic: 'טבלאות אמת', count: 3, of: 3 }], pastExams: ['x', 'y', 'z'], links: [], linkedSkills: [], createdAt: now });
  r = await j(`/api/folders/${c._id}/merge`, { method: 'POST', body: JSON.stringify({ into: d._id }) }, token);
  const moved = await db.collection('courseprofiles').findOne({ userId: uid, course: 'לוגיקה' });
  check('the only exam map: it becomes the target\'s', r.status === 200 && moved && same(moved.courseId, d._id) && moved.recurring[0].topic === 'טבלאות אמת', JSON.stringify(moved && [moved.course, moved.courseId]));
  r = await j(`/api/folders/${c._id}/merge`, { method: 'POST', body: JSON.stringify({ into: d._id }) }, token);
  check('merging a course that is gone: 404', r.status === 404, String(r.status));

  // ---- A name with no course into a course (absorb)
  const ORPHAN = 'הסתברות';
  await db.collection('studyitems').insertMany([1, 2].map(i => ({ userId: uid, question: `יתום ${i}`, answer: 'x', category: ORPHAN, courseId: null, suspended: false, mode: 'recall', skillTag: 't', dueDate: now, interval: 0, repetitions: 0, easeFactor: 2.5, reviews: [], createdAt: now })));
  await db.collection('examruns').insertOne({ userId: uid, course: ORPHAN, clientRunId: 'r9', startedAt: now, finishedAt: now, answers: [], score: 40 });
  await db.collection('courseprofiles').insertOne({ userId: uid, course: ORPHAN, recurring: [{ topic: 'יתום', count: 2, of: 2 }], pastExams: [], links: [], linkedSkills: [], createdAt: now });
  // same name, but already some course's: not touched
  const dId = new mongoose.Types.ObjectId(String(d._id));
  await db.collection('studyitems').insertOne({ userId: uid, question: 'של קורס אחר', answer: 'x', category: ORPHAN, courseId: dId, suspended: false, mode: 'recall', skillTag: 't', dueDate: now, interval: 0, repetitions: 0, easeFactor: 2.5, reviews: [], createdAt: now });
  r = await j(`/api/folders/${into._id}/absorb`, { method: 'POST', body: JSON.stringify({ name: 'לוגיקה' }) }, token);
  check('absorb a name that is one of the courses: refused (that\'s a merge)', r.status === 400, String(r.status));
  r = await j(`/api/folders/${into._id}/absorb`, { method: 'POST', body: JSON.stringify({ name: 'Uncategorized' }) }, token);
  check('absorb "no course" itself: refused', r.status === 400, String(r.status));
  r = await j(`/api/folders/${into._id}/absorb`, { method: 'POST', body: JSON.stringify({ name: ORPHAN }) }, other);
  check('another student can\'t absorb into my course', r.status === 404, String(r.status));
  r = await j(`/api/folders/${into._id}/absorb`, { method: 'POST', body: JSON.stringify({ name: ORPHAN }) }, token);
  const orphanQs = await db.collection('studyitems').find({ userId: uid, question: /^יתום/ }).toArray();
  const otherQ = await db.collection('studyitems').findOne({ userId: uid, question: 'של קורס אחר' });
  const orun = await db.collection('examruns').findOne({ userId: uid, clientRunId: 'r9' });
  check('absorb: the name\'s questions and mock exam are the course\'s now', r.status === 200 && orphanQs.length === 2 && orphanQs.every(q => q.category === INTO && same(q.courseId, iid)) && orun.course === INTO && same(orun.courseId, iid), JSON.stringify([r.status, orphanQs.map(q => q.category), orun.course]));
  check('absorb: a record of that name that is another course\'s - not touched', otherQ.category === ORPHAN && same(otherQ.courseId, dId));
  check('absorb: the course had an exam map - the name\'s goes', !(await db.collection('courseprofiles').findOne({ userId: uid, course: ORPHAN })) && !!(await db.collection('courseprofiles').findOne({ userId: uid, course: INTO })));
  check('absorb: the course stays', (await j('/api/folders', {}, token)).body.some(f => f.name === INTO));

  console.log(results.join('\n'));
  console.log(`${results.filter(x => x.startsWith('PASS')).length}/${results.length}`);
  await mongoose.disconnect();
})().catch(async (err) => { console.log(results.join('\n')); console.log('FAIL the test crashed:', err.message); try { await mongoose.disconnect(); } catch (e) { /* closed */ } process.exit(1); });
