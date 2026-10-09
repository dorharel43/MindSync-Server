// A course is a folder, and everything of a course keeps its id (8/10):
// the migration of data saved before that, new saves, rename and delete.
// Usage: node tests/e2e/courses.test.js http://127.0.0.1:5070
const base = process.argv[2] || process.env.TEST_BASE || 'http://127.0.0.1:5070';
const mongoose = require('mongoose');
const { migrateCourses } = require('../../utils/courses');
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
const C = 'חדו"א 2';
let n = 0;

(async () => {
  await mongoose.connect(`${(process.env.TEST_MONGO || 'mongodb://127.0.0.1:27017').replace(/\/$/, '')}/${process.env.TEST_DB || 'mindsync_tt3'}`);
  const db = mongoose.connection.db;
  const reg = async (tag) => (await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `crs${tag}${Date.now()}@example.com`, password: 'password123', name: 'בודק' }) })).body.token;

  // ---- 1. Data saved before courseId: written straight to the collections, in the old shape.
  const token = await reg('a');
  const uid = new mongoose.Types.ObjectId(idOf(token));
  const now = new Date();
  const LONG = 'קורס ארוך '.repeat(11).trim();   // 109 characters - folders before 8/10 allowed 120
  await db.collection('folders').insertMany([{ userId: uid, name: C, createdAt: now, updatedAt: now }, { userId: uid, name: LONG, createdAt: now, updatedAt: now }]);
  await db.collection('studyitems').insertOne({ question: 'בלי משתמש', answer: 'a', category: C, createdAt: now });   // broken legacy record
  await db.collection('fileitems').insertMany([
    { userId: uid, name: 'מבחן 2024 מועד א.pdf', folder: C, content: 'x', createdAt: now },
    { userId: uid, name: 'הרצאה 1.pdf', folder: C, content: 'x', createdAt: now },
    { userId: uid, name: 'משהו.pdf', folder: 'No Folder', content: 'x', createdAt: now },
    { userId: uid, name: 'ארוך.pdf', folder: LONG, content: 'x', createdAt: now }
  ]);
  const item = (category, q) => ({ userId: uid, question: q, answer: 'a', mode: 'recall', category, skillTag: 't', dueDate: now, interval: 0, repetitions: 0, easeFactor: 2.5, reviews: [], createdAt: now });
  await db.collection('studyitems').insertMany([item(C, 'q1'), item(C, 'q2'), item('סטטיסטיקה', 'q3'), item('Uncategorized', 'q4')]);
  await db.collection('courseprofiles').insertOne({ userId: uid, course: C, recurring: [{ topic: 'טורים', count: 2, of: 2 }], pastExams: ['a', 'b'], links: [], linkedSkills: [], createdAt: now });
  await db.collection('examruns').insertOne({ userId: uid, course: 'סטטיסטיקה', clientRunId: 'r1', startedAt: now, finishedAt: now, answers: [], score: 50 });
  await db.collection('events').insertMany([
    { userId: uid, title: `מבחן ב${C}`, type: 'exam', day: 'Monday', date: '2026-12-01', time: '09:00' },
    { userId: uid, title: 'מבחן סוף סמסטר', type: 'exam', day: 'Monday', date: '2026-12-02', time: '09:00' },
    { userId: uid, title: 'הרצאה', type: 'class', day: 'Monday', time: '09:00' }
  ]);

  const foldersBefore = await db.collection('folders').countDocuments({ userId: uid });
  const c1 = await migrateCourses();
  const calc = await db.collection('folders').findOne({ userId: uid, name: C });
  check('migration: creates no folder (only folders the student made are courses)', (await db.collection('folders').countDocuments({ userId: uid })) === foldersBefore && !(await db.collection('folders').findOne({ userId: uid, name: 'סטטיסטיקה' })), JSON.stringify(c1));
  check('migration: a broken record (no user) is skipped, the rest done', c1.linked > 0, JSON.stringify(c1));
  const items = await db.collection('studyitems').find({ userId: uid }).toArray();
  const byQ = Object.fromEntries(items.map(i => [i.question, i]));
  check('migration: questions get their course id; a name with no folder null', same(byQ.q1.courseId, calc._id) && same(byQ.q2.courseId, calc._id) && byQ.q3.courseId === null, JSON.stringify(items.map(i => [i.question, i.courseId])));
  check('migration: a question with no course gets null (not linked)', byQ.q4.courseId === null && byQ.q4.category === 'Uncategorized');
  const files = await db.collection('fileitems').find({ userId: uid }).toArray();
  const byName = Object.fromEntries(files.map(f => [f.name, f]));
  check('migration: files get the course id; "No Folder" null', same(byName['מבחן 2024 מועד א.pdf'].courseId, calc._id) && byName['משהו.pdf'].courseId === null);
  check('migration: file roles from the name', byName['מבחן 2024 מועד א.pdf'].role === 'past_exam' && byName['הרצאה 1.pdf'].role === 'material', JSON.stringify(files.map(f => [f.name, f.role])));
  check('migration: exam map linked; a mock exam of a name with no folder null', same((await db.collection('courseprofiles').findOne({ userId: uid })).courseId, calc._id) && (await db.collection('examruns').findOne({ userId: uid })).courseId === null);
  const longFolder = await db.collection('folders').findOne({ userId: uid, name: LONG });
  check('migration: a folder name over 100 characters is matched whole (no cut copy)', same(byName['ארוך.pdf'].courseId, longFolder._id) && (await db.collection('folders').countDocuments({ userId: uid, name: LONG.slice(0, 100) })) === 0);
  const evs = await db.collection('events').find({ userId: uid }).toArray();
  const byT = Object.fromEntries(evs.map(e => [e.title, e]));
  check('migration: an exam naming one course is linked', same(byT[`מבחן ב${C}`].courseId, calc._id), JSON.stringify(byT[`מבחן ב${C}`].courseId));
  check('migration: an exam naming no course stays unlinked (never guessed)', byT['מבחן סוף סמסטר'].courseId === null);
  check('migration: names are kept', byQ.q1.category === C && byName['הרצאה 1.pdf'].folder === C);
  const c2 = await migrateCourses();
  check('migration: a second run changes nothing', c2.linked === 0 && c2.unlinked === 0 && c2.exams === 0 && c2.roles === 0, JSON.stringify(c2));

  // ---- 1b. A folder the student makes takes in what carries its name.
  let r0 = await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'סטטיסטיקה' }) }, token);
  const stats = r0.body;
  const q3 = await db.collection('studyitems').findOne({ _id: byQ.q3._id });
  check('new folder: takes in the questions and mock exam of its name', r0.status === 201 && same(q3.courseId, stats._id) && same((await db.collection('examruns').findOne({ userId: uid })).courseId, stats._id), JSON.stringify([r0.status, q3.courseId]));

  // ---- 2. Rename: everything of the course follows (it used to be only the files).
  const NEW = 'חדו"א 2 - מתקדם';
  let r = await j(`/api/folders/${calc._id}`, { method: 'PUT', body: JSON.stringify({ name: NEW }) }, token);
  check('rename: ok', r.status === 200, String(r.status));
  const q1 = await db.collection('studyitems').findOne({ _id: byQ.q1._id });
  const prof = await db.collection('courseprofiles').findOne({ userId: uid });
  const f1 = await db.collection('fileitems').findOne({ _id: byName['הרצאה 1.pdf']._id });
  check('rename: questions, exam map and files carry the new name', q1.category === NEW && prof.course === NEW && f1.folder === NEW, JSON.stringify([q1.category, prof.course, f1.folder]));
  r = await j(`/api/exam-map?course=${encodeURIComponent(NEW)}`, {}, token);
  check('rename: the exam map is found under the new name', r.body.profile && r.body.profile.recurring.length === 1, JSON.stringify(r.body.profile && r.body.profile.recurring));
  r = await j(`/api/folders/${calc._id}`, { method: 'PUT', body: JSON.stringify({ name: 'x'.repeat(101) }) }, token);
  check('rename: over 100 characters is refused', r.status === 400, String(r.status));
  r = await j(`/api/folders/${calc._id}`, { method: 'PUT', body: JSON.stringify({ name: 'סטטיסטיקה' }) }, token);
  check('rename: to another course\'s name is refused, nothing changed', r.status === 409 && (await db.collection('studyitems').findOne({ _id: byQ.q1._id })).category === NEW, String(r.status));
  // An exam map kept from a deleted course, under the name we rename to: refused before anything moves.
  await db.collection('courseprofiles').insertOne({ userId: uid, course: 'ישן', courseId: null, recurring: [], pastExams: [], links: [], linkedSkills: [] });
  r = await j(`/api/folders/${calc._id}`, { method: 'PUT', body: JSON.stringify({ name: 'ישן' }) }, token);
  const q1b = await db.collection('studyitems').findOne({ _id: byQ.q1._id });
  check('rename: onto a deleted course\'s exam map name - refused, nothing half-moved', r.status === 409 && q1b.category === NEW && (await db.collection('folders').findOne({ _id: calc._id })).name === NEW, JSON.stringify([r.status, q1b.category]));

  // ---- 3. New saves carry the course id.
  r = await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: [{ question: 'יתומה', answer: 'a', category: 'לוגיקה' }] }) }, token);
  check('new questions: a course name with no folder makes no folder', !(await db.collection('folders').findOne({ userId: uid, name: 'לוגיקה' })) && (await db.collection('studyitems').findOne({ userId: uid, question: 'יתומה' })).courseId === null);
  const logic = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'לוגיקה' }) }, token)).body;
  r = await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: [{ question: 'חדשה', answer: 'a', category: 'לוגיקה' }, { question: 'בלי קורס', answer: 'a', category: '' }] }) }, token);
  const fresh = await db.collection('studyitems').find({ userId: uid, question: { $in: ['חדשה', 'בלי קורס', 'יתומה'] } }).toArray();
  check('new questions: the course id is saved (and the earlier one was taken in)', same(fresh.find(i => i.question === 'חדשה').courseId, logic._id) && same(fresh.find(i => i.question === 'יתומה').courseId, logic._id) && fresh.find(i => i.question === 'בלי קורס').courseId === null, JSON.stringify(fresh.map(i => i.courseId)));
  r = await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'logic_moed_a.pdf', content: 'x', folder: 'לוגיקה' }) }, token);
  check('new file: course id and role (moed_a is a past exam)', same(r.body.courseId, logic._id) && r.body.role === 'past_exam', JSON.stringify([r.body.courseId, r.body.role]));
  r = await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'סילבוס.pdf', content: 'x', folder: 'לוגיקה', role: 'syllabus' }) }, token);
  check('new file: the role the student picked wins', r.body.role === 'syllabus', r.body.role);
  r = await j('/api/events', { method: 'POST', body: JSON.stringify({ title: 'מבחן בלוגיקה', type: 'exam', day: 'Monday', date: '2026-12-03', time: '09:00' }) }, token);
  check('new exam: linked to the course its title names', same(r.body.courseId, logic._id), JSON.stringify(r.body.courseId));
  const ev = r.body;
  r = await j(`/api/events/${ev._id || ev.id}`, { method: 'PUT', body: JSON.stringify({ courseId: String(stats._id) }) }, token);
  check('exam: the course the student picks wins', same(r.body.courseId, stats._id), JSON.stringify(r.body.courseId));
  // The app sends title and type on every edit (a date change): the pick stays.
  r = await j(`/api/events/${ev._id || ev.id}`, { method: 'PUT', body: JSON.stringify({ title: 'מבחן בלוגיקה', type: 'exam', date: '2026-12-04' }) }, token);
  check('exam: an edit (title + type sent again) keeps the picked course', same(r.body.courseId, stats._id), JSON.stringify(r.body.courseId));
  r = await j(`/api/events/${ev._id || ev.id}`, { method: 'PUT', body: JSON.stringify({ title: `מבחן ב${NEW}`, type: 'exam' }) }, token);
  check('exam: even a new title keeps the picked course', same(r.body.courseId, stats._id), JSON.stringify(r.body.courseId));
  const auto = (await j('/api/events', { method: 'POST', body: JSON.stringify({ title: 'מבחן בלוגיקה', type: 'exam', day: 'Monday', date: '2026-12-05', time: '09:00' }) }, token)).body;
  r = await j(`/api/events/${auto._id || auto.id}`, { method: 'PUT', body: JSON.stringify({ title: 'מבחן בלוגיקה', type: 'exam', date: '2026-12-06' }) }, token);
  check('exam: an automatic link stays when the title doesn\'t change', same(r.body.courseId, logic._id), JSON.stringify(r.body.courseId));
  r = await j(`/api/events/${auto._id || auto.id}`, { method: 'PUT', body: JSON.stringify({ title: 'מבחן בסטטיסטיקה', type: 'exam' }) }, token);
  check('exam: an automatic link follows a new title', same(r.body.courseId, stats._id), JSON.stringify(r.body.courseId));
  const other = await reg('b');
  const theirs = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'שלהם' }) }, other)).body;
  r = await j(`/api/events/${ev._id || ev.id}`, { method: 'PUT', body: JSON.stringify({ courseId: String(theirs._id) }) }, token);
  check('exam: another user\'s course is refused', r.status === 400, String(r.status));

  // ---- 4. Delete: the history stays, unlinked - and is not brought back.
  const geo = (await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'גאומטריה' }) }, token)).body;
  const made = (await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: [{ question: 'גאו', answer: 'a', category: 'גאומטריה' }] }) }, token)).body;
  r = await j(`/api/folders/${geo._id}`, { method: 'DELETE' }, token);
  const geoItem = await db.collection('studyitems').findOne({ userId: uid, question: 'גאו' });
  check('delete: the questions keep their name, without the id', r.status === 200 && geoItem.category === 'גאומטריה' && geoItem.courseId === null, JSON.stringify([r.status, geoItem.category, geoItem.courseId]));
  const madeId = (Array.isArray(made) ? made : made.items || [])[0];
  await j(`/api/study/${madeId._id || madeId.id}/review`, { method: 'POST', body: JSON.stringify({ confidence: 'sure', outcome: 'got_it', clientId: `c${++n}` }) }, token);
  check('delete: answering one of its questions doesn\'t bring the course back', !(await db.collection('folders').findOne({ userId: uid, name: 'גאומטריה' })));
  await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: [{ question: 'גאו 2', answer: 'a', category: 'גאומטריה' }] }) }, token);
  check('delete: a new question with its name doesn\'t bring it back either', !(await db.collection('folders').findOne({ userId: uid, name: 'גאומטריה' })));

  // ---- 5. Account deleted: no course left.
  r = await j('/api/auth/me', { method: 'DELETE', body: JSON.stringify({ password: 'password123' }) }, token);
  check('account deleted: no course left', r.status === 200 && (await db.collection('folders').countDocuments({ userId: uid })) === 0, String(r.status));

  await mongoose.disconnect();
  console.log(results.join('\n'));
  console.log(`${results.filter(x => x.startsWith('PASS')).length}/${results.length}`);
})().catch(e => { console.error('E2E FAIL', e); process.exit(1); });
