// A course is a folder (8/10). Until now a course was only a name, written
// separately into every file, question, exam map, mock exam and full exam -
// renaming a folder moved the files and left everything else behind. Now
// each of those also keeps the folder's id (courseId).
//
// Only folders the student made are courses: a name is linked to the folder
// of that exact name, and nothing here creates a folder. A name with no
// folder (a question's course typed by hand, a deleted folder's history)
// stays a name, with courseId null - until the student makes a folder of
// that name, which then takes those records in (adoptByName).
//
// The name fields stay (they're what the screens read today); courseId is
// written next to them on every save.
const mongoose = require('mongoose');
const Folder = require('../models/Folder');
const { examMatchesCourse } = require('./examSchedule');

// Names that mean "no course": the app's own placeholders.
const NO_COURSE = new Set(['', 'Uncategorized', 'No Folder']);

// A past exam, by the file's name - the default a student can change (role).
const PAST_EXAM_FILE = /מבחן|בחינה|מועד|בוחן|(?:^|[^a-z])exams?(?![a-z])|(?:^|[^a-z])moed(?![a-z])|midterm|quiz|final exam/i;
const roleOf = (fileName) => (PAST_EXAM_FILE.test(String(fileName || '')) ? 'past_exam' : 'material');

// (no cutting: a folder made before 8/10 may have a name up to 120 characters)
const cleanName = (name) => String(name == null ? '' : name).trim();

// The id of the student's folder of this exact name - null when there's none.
async function courseIdFor(userId, name) {
  const n = cleanName(name);
  if (NO_COURSE.has(n)) return null;
  const found = await Folder.findOne({ userId, name: n }).select('_id').lean();
  return found ? found._id : null;
}

// Many names at once (a bulk save): name -> id.
async function courseIdsFor(userId, names) {
  const out = new Map();
  for (const name of new Set(names.map(cleanName))) out.set(name, await courseIdFor(userId, name));
  return out;
}

// The exam event's course: the one course whose name the title names - none
// when it names no course or more than one (the student picks).
async function examCourseId(userId, title) {
  const folders = await Folder.find({ userId }).select('_id name').lean();
  const hits = folders.filter(f => !NO_COURSE.has(f.name) && examMatchesCourse(title, f.name));
  return hits.length === 1 ? hits[0]._id : null;
}

// Every record that names a course: model, its name field.
const NAMED = () => [
  [require('../models/FileItem'), 'folder'],
  [require('../models/StudyItem'), 'category'],
  [require('../models/CourseProfile'), 'course'],
  [require('../models/ExamRun'), 'course'],
  [require('../models/FullExam'), 'course'],
  [require('../models/FullExamRun'), 'course']
];

// A rename would give this course's exam map the name of another exam map
// (one kept from a deleted folder): the exam map's name is unique per user.
async function renameClash(userId, courseId, name) {
  const CourseProfile = require('../models/CourseProfile');
  return !!(await CourseProfile.findOne({ userId, course: cleanName(name), courseId: { $ne: courseId } }).select('_id').lean());
}

// Everything of the course, by id, gets the new name. Called BEFORE the
// folder itself is renamed: if anything fails, the folder keeps its old name
// and the rename can simply be tried again (this is safe to repeat).
async function renameCourse(userId, courseId, name) {
  const n = cleanName(name);
  for (const [Model, field] of NAMED()) {
    await Model.updateMany({ userId, courseId }, { $set: { [field]: n } });
  }
}

// A new folder takes in what already carries its name and no course (a
// question's course typed by hand, a deleted folder's history).
async function adoptByName(userId, courseId, name) {
  const n = cleanName(name);
  if (NO_COURSE.has(n)) return 0;
  let linked = 0;
  for (const [Model, field] of NAMED()) {
    const r = await Model.updateMany({ userId, [field]: n, $or: [{ courseId: null }, { courseId: { $exists: false } }] }, { $set: { courseId } });
    linked += r.modifiedCount || 0;
  }
  return linked;
}

// A removed course: its files go to "No Folder" (as before); everything
// else keeps its name and history, only without the course's id.
async function removeCourse(userId, courseId) {
  const FileItem = require('../models/FileItem');
  await FileItem.updateMany({ userId, courseId }, { $set: { folder: 'No Folder', courseId: null } });
  for (const [Model] of NAMED().slice(1)) await Model.updateMany({ userId, courseId }, { $set: { courseId: null } });
  await require('../models/Event').updateMany({ userId, courseId }, { $set: { courseId: null, coursePicked: false } });
}

// The data from before courseId (8/10): every record that names a course gets
// the id of the folder of that name - or null (no such folder, or no course);
// exam events get the one course their title names; files get a role. Only
// adds - the names stay, nothing is deleted or created - and a second run
// finds nothing to do. A record that can't be handled is skipped (logged),
// never stops the rest.
async function migrateCourses() {
  const counts = { linked: 0, unlinked: 0, exams: 0, roles: 0, skipped: 0 };
  const step = async (name, fn) => { try { await fn(); } catch (err) { counts.skipped += 1; console.warn(`courses migration (${name}):`, err.message); } };
  for (const [Model, field] of NAMED()) {
    await step(Model.modelName, async () => {
      const docs = await Model.find({ courseId: { $exists: false } }).select(`userId ${field}`).lean();
      const groups = new Map();   // [userId, name] -> ids
      for (const d of docs) {
        if (!d.userId) { counts.skipped += 1; continue; }
        const key = JSON.stringify([String(d.userId), cleanName(d[field])]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d._id);
      }
      for (const [key, ids] of groups) {
        await step(Model.modelName, async () => {
          const [userId, name] = JSON.parse(key);
          const courseId = await courseIdFor(new mongoose.Types.ObjectId(userId), name);
          const r = await Model.updateMany({ _id: { $in: ids }, courseId: { $exists: false } }, { $set: { courseId } });
          counts[courseId ? 'linked' : 'unlinked'] += r.modifiedCount || 0;
        });
      }
    });
  }
  await step('Event', async () => {
    const Event = require('../models/Event');
    const exams = await Event.find({ type: 'exam', courseId: { $exists: false } }).select('userId title').lean();
    for (const e of exams) {
      if (!e.userId) { counts.skipped += 1; continue; }
      await step('Event', async () => {
        const courseId = await examCourseId(e.userId, e.title);
        await Event.updateOne({ _id: e._id, courseId: { $exists: false } }, { $set: { courseId } });
        if (courseId) counts.exams += 1;
      });
    }
  });
  await step('FileItem role', async () => {
    const FileItem = require('../models/FileItem');
    const files = await FileItem.find({ role: { $exists: false } }).select('name').lean();
    for (const f of files) {
      await FileItem.updateOne({ _id: f._id, role: { $exists: false } }, { $set: { role: roleOf(f.name) } });
      counts.roles += 1;
    }
  });
  return counts;
}

module.exports = { NO_COURSE, PAST_EXAM_FILE, roleOf, cleanName, courseIdFor, courseIdsFor, examCourseId, renameClash, renameCourse, adoptByName, removeCourse, migrateCourses };
