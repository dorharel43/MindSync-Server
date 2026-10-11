// A file's course and what it is (8/10): picked at upload, changed on the
// file's row, and "What repeats in the exam" goes by what the student said -
// the file's name decides only for a file from before (no role).
// Usage: node tests/e2e/files.test.js http://127.0.0.1:5070
const base = process.argv[2] || process.env.TEST_BASE || 'http://127.0.0.1:5070';
const mongoose = require('mongoose');
const j = async (path, opts = {}, token) => {
  const res = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const t = await res.text();
  let body; try { body = JSON.parse(t); } catch (e) { body = { text: t.slice(0, 200) }; }
  return { status: res.status, body };
};
const rpc = async (token, ch, ...args) => { const r = await j(`/api/rpc/${ch}`, { method: 'POST', body: JSON.stringify({ args }) }, token); return r.body.result !== undefined ? r.body.result : r.body; };
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
const same = (a, b) => a != null && b != null && String(a) === String(b);
const idOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
const C = 'מבני נתונים';

(async () => {
  await mongoose.connect(`${(process.env.TEST_MONGO || 'mongodb://127.0.0.1:27017').replace(/\/$/, '')}/${process.env.TEST_DB || 'mindsync_tt3'}`);
  const db = mongoose.connection.db;
  const reg = async (tag) => (await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `fil${tag}${Date.now()}@example.com`, password: 'password123', name: 'בודקת' }) })).body.token;
  const token = await reg('a');
  const other = await reg('b');
  const course = (await rpc(token, 'save-folder', { name: C })) || {};
  check('a course is made', !!(course._id || course.id), JSON.stringify(course).slice(0, 120));
  const courseId = course._id || course.id;

  // ---- 1. Upload: the role the student picked is kept, whatever the name says.
  const a = await rpc(token, 'save-file', { name: '2023_A.pdf', content: 'x', folder: C, role: 'past_exam' });
  check('upload: a past exam the name doesn\'t give away keeps its role', a.role === 'past_exam' && same(a.courseId, courseId), JSON.stringify([a.role, a.courseId]));
  const d = await rpc(token, 'save-file', { name: '2022_B.pdf', content: 'x', folder: C, role: 'past_exam' });
  const b = await rpc(token, 'save-file', { name: 'מבחן 2024 - דף נוסחאות.pdf', content: 'x', folder: C, role: 'material' });
  check('upload: "material" wins over an exam-like name', b.role === 'material', b.role);
  const s = await rpc(token, 'save-file', { name: 'notes.pdf', content: 'x', folder: 'No Folder', role: 'syllabus' });
  check('upload: "No course" is a course id of null', s.role === 'syllabus' && s.courseId === null, JSON.stringify([s.role, s.courseId]));

  // A file from before roles (no role field): its name decides.
  await db.collection('fileitems').insertOne({ userId: new mongoose.Types.ObjectId(idOf(token)), name: 'מבחן 2022 מועד א.pdf', content: 'x', folder: C, courseId: new mongoose.Types.ObjectId(String(courseId)), createdAt: new Date() });

  // ---- 2. "What repeats": counts what the student marked (+ the old file by its name).
  let m = await rpc(token, 'exam-map', C);
  // (by role: 2023_A, 2022_B and the old file = 3; by name it would be 2)
  check('exam map: counts the files marked "past exam" (and an old file by its name)', !!d.role && m.pastExams === 3, JSON.stringify(m).slice(0, 160));
  let st = await rpc(token, 'get-onboarding-status');
  check('guide: past exams counted by role too', st && st.pastExams === 3, JSON.stringify(st).slice(0, 160));

  // ---- 3. Changing a file on its row.
  let r = await rpc(token, 'update-file', a._id || a.id, { role: 'material' });
  check('change: the role', r.role === 'material', JSON.stringify(r).slice(0, 120));
  m = await rpc(token, 'exam-map', C);
  check('change: the exam map follows the role', m.pastExams === 2, String(m.pastExams));
  r = await rpc(token, 'update-file', s._id || s.id, { folder: C });
  check('change: moving a file to a course gives it the course id', r.folder === C && same(r.courseId, courseId), JSON.stringify([r.folder, r.courseId]));
  r = await rpc(token, 'update-file', s._id || s.id, { folder: 'No Folder' });
  check('change: back to "No course" - course id null', r.folder === 'No Folder' && r.courseId === null, JSON.stringify([r.folder, r.courseId]));
  r = await rpc(token, 'update-file', b._id || b.id, { role: 'bogus', name: 'renamed.pdf', content: '' });
  const bNow = await db.collection('fileitems').findOne({ _id: new mongoose.Types.ObjectId(String(b._id || b.id)) });
  check('change: only course and role - a made-up role or anything else is refused', !!(r && r.error) && bNow.role === 'material' && bNow.name === b.name && bNow.content === 'x', JSON.stringify([r, bNow.name]));
  r = await rpc(other, 'update-file', a._id || a.id, { role: 'past_exam' });
  const aNow = await db.collection('fileitems').findOne({ _id: new mongoose.Types.ObjectId(String(a._id || a.id)) });
  check('change: another student\'s file can\'t be changed', !!(r && r.error) && aNow.role === 'material', JSON.stringify(r).slice(0, 120));

  r = await rpc(token, 'update-file', b._id || b.id, { role: 'past_exam', name: 'renamed.pdf', content: '' });
  const bAfter = await db.collection('fileitems').findOne({ _id: new mongoose.Types.ObjectId(String(b._id || b.id)) });
  check('change: with a real role, a name or text sent along is still dropped', r.role === 'past_exam' && bAfter.name === b.name && bAfter.content === 'x', JSON.stringify([bAfter.role, bAfter.name]));
  await rpc(token, 'update-file', b._id || b.id, { role: 'material' });

  // ---- 4. A mock exam puts the questions of what the student marked "past exam" first.
  const qs = [];
  for (let k = 0; k < 4; k++) qs.push({ question: `ממבחן ${k}`, answer: 'x', category: C, skillTag: 'מיון', sourceFile: '2022_B.pdf' });
  for (let k = 0; k < 4; k++) qs.push({ question: `מהדף ${k}`, answer: 'x', category: C, skillTag: 'מיון', sourceFile: 'מבחן 2024 - דף נוסחאות.pdf' });
  await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: qs }) }, token);
  const pick = (await j(`/api/study/exam/pick?course=${encodeURIComponent(C)}&count=4`, {}, token)).body;
  const items = Array.isArray(pick) ? pick : (pick.items || []);
  const flagged = items.filter(i => i.fromPastExam).map(i => i.question);
  check('mock exam: "past exam" by the file\'s role (2022_B yes, the "מבחן" formula sheet marked material no)', items.length > 0 && flagged.length > 0 && flagged.every(q => q.startsWith('ממבחן')) && !items.some(i => i.question.startsWith('מהדף') && i.fromPastExam), JSON.stringify(items.map(i => [i.question, i.fromPastExam])));

  // ---- 5. Names the app keeps for itself aren't a course's name.
  const bad = [];
  for (const name of ['No Folder', 'Uncategorized', '__newcourse__', '__new__:x']) {
    const res = await j('/api/folders', { method: 'POST', body: JSON.stringify({ name }) }, token);
    if (res.status !== 400) bad.push([name, res.status]);
  }
  const ren = await j(`/api/folders/${courseId}`, { method: 'PUT', body: JSON.stringify({ name: 'No Folder' }) }, token);
  check('names the app keeps ("No Folder", "Uncategorized", "__…") are refused - new or renamed', !bad.length && ren.status === 400, JSON.stringify([bad, ren.status]));

  console.log(results.join('\n'));
  console.log(`${results.filter(x => x.startsWith('PASS')).length}/${results.length}`);
  await mongoose.disconnect();
})().catch(async (err) => { console.log('FAIL the test crashed:', err.message); try { await mongoose.disconnect(); } catch (e) { /* closed */ } process.exit(1); });
