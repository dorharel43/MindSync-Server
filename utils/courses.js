// A course is a folder (8/10). Until now a course was only a name, written
// separately into every file, question, exam map, mock exam and full exam -
// renaming a folder moved the files and left everything else behind. Now
// each of those also keeps the folder's id (courseId): this module turns a
// name into that id (creating the folder when a name has none yet, e.g. a
// question's course typed by hand), renames and removes by id, and moves the
// data written before this change over (migrate).
//
// The name fields stay (they're what the screens read today); courseId is
// written next to them on every save.
const mongoose = require('mongoose');
const Folder = require('../models/Folder');
const { examMatchesCourse } = require('./examSchedule');

// Names that mean "no course": the app's own placeholders.
const NO_COURSE = new Set(['', 'Uncategorized', 'No Folder']);
const NAME_MAX = 100;   // the course name fields' limit (StudyItem.category etc.)

// A past exam, by the file's name - the default a student can change (role).
const PAST_EXAM_FILE = /מבחן|בחינה|מועד|בוחן|(?:^|[^a-z])exams?(?![a-z])|(?:^|[^a-z])moed(?![a-z])|midterm|quiz|final exam/i;
const roleOf = (fileName) => (PAST_EXAM_FILE.test(String(fileName || '')) ? 'past_exam' : 'material');

const cleanName = (name) => String(name == null ? '' : name).trim().slice(0, NAME_MAX);

// The folder (course) id for this name - created when there's none. null for
// "no course". Two saves at once can both try to create it: the unique index
// lets one win and the other reads it.
async function courseIdFor(userId, name) {
  const n = cleanName(name);
  if (NO_COURSE.has(n)) return null;
  const found = await Folder.findOne({ userId, name: n }).select('_id').lean();
  if (found) return found._id;
  try {
    return (await Folder.create({ userId, name: n }))._id;
  } catch (err) {
    if (err && err.code === 11000) {
      const again = await Folder.findOne({ userId, name: n }).select('_id').lean();
      if (again) return again._id;
    }
    throw err;
  }
}

// Many names at once (a bulk save): name -> id.
async function courseIdsFor(userId, names) {
  const out = new Map();
  for (const name of new Set(names.map(cleanName))) out.set(name, await courseIdFor(userId, name));
  return out;
}

// The exam event's course: the one course whose name the title names - none
// when it names no course or more than one (the student picks, later).
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

// A rename reaches everything of the course, by id - not only the files.
async function renameCourse(userId, courseId, name) {
  const n = cleanName(name);
  for (const [Model, field] of NAMED()) {
    await Model.updateMany({ userId, courseId }, { $set: { [field]: n } });
  }
}

// A removed course: its files go to "No Folder" (as before); everything
// else keeps its name and history, only without the course's id.
async function removeCourse(userId, courseId) {
  const FileItem = require('../models/FileItem');
  const { modifiedCount } = await FileItem.updateMany({ userId, courseId }, { $set: { folder: 'No Folder', courseId: null } });
  for (const [Model] of NAMED().slice(1)) await Model.updateMany({ userId, courseId }, { $set: { courseId: null } });
  await require('../models/Event').updateMany({ userId, courseId }, { $set: { courseId: null } });
  return modifiedCount;
}

// The data from before courseId (8/10): every record that names a course gets
// its folder's id (the folder made when there's none); exam events get the
// one course their title names; files get a role. Only adds - the names stay,
// nothing is deleted - and running it again changes nothing. Records with no
// course get courseId null, so the next run skips them.
async function migrateCourses() {
  const counts = { courses: 0, linked: 0, exams: 0, roles: 0 };
  const before = await Folder.countDocuments({});
  for (const [Model, field] of NAMED()) {
    const docs = await Model.find({ courseId: { $exists: false } }).select(`userId ${field}`).lean();
    const groups = new Map();   // userId \n name -> [ids]
    for (const d of docs) {
      const key = `${d.userId}\n${cleanName(d[field])}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d._id);
    }
    for (const [key, ids] of groups) {
      const [userId, name] = key.split('\n');
      const courseId = await courseIdFor(new mongoose.Types.ObjectId(userId), name);
      const r = await Model.updateMany({ _id: { $in: ids } }, { $set: { courseId } });
      if (courseId) counts.linked += r.modifiedCount || 0;
    }
  }
  const Event = require('../models/Event');
  const exams = await Event.find({ type: 'exam', courseId: { $exists: false } }).select('userId title').lean();
  for (const e of exams) {
    const courseId = await examCourseId(e.userId, e.title);
    await Event.updateOne({ _id: e._id }, { $set: { courseId } });
    if (courseId) counts.exams += 1;
  }
  const FileItem = require('../models/FileItem');
  const files = await FileItem.find({ role: { $exists: false } }).select('name').lean();
  for (const f of files) {
    await FileItem.updateOne({ _id: f._id }, { $set: { role: roleOf(f.name) } });
    counts.roles += 1;
  }
  counts.courses = (await Folder.countDocuments({})) - before;
  return counts;
}

module.exports = { NO_COURSE, PAST_EXAM_FILE, roleOf, cleanName, courseIdFor, courseIdsFor, examCourseId, renameCourse, removeCourse, migrateCourses };
