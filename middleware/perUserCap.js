// How many of each thing one account can have (30/9 security pass). The
// database is shared by everyone (Atlas free tier = 512MB); without a cap
// one account could fill it and stop writes for all users. The numbers are
// far above what a student uses in a year.
const ApiError = require('./ApiError');

const num = (v, d) => Number(v) || d;
const CAPS = {
    Task: num(process.env.CAP_TASKS, 3000),
    Event: num(process.env.CAP_EVENTS, 3000),
    FileItem: num(process.env.CAP_FILES, 1000),
    Folder: num(process.env.CAP_FOLDERS, 300),
    StudyItem: num(process.env.CAP_STUDY_ITEMS, 6000)
};
const LABELS = { Task: 'tasks', Event: 'calendar items', FileItem: 'files', Folder: 'folders', StudyItem: 'questions' };

async function assertRoom(Model, userId, adding = 1) {
    const name = Model.modelName;
    const cap = CAPS[name];
    if (!cap) return;
    const have = await Model.countDocuments({ userId });
    if (have + adding > cap) {
        throw new ApiError(400, `You've reached the limit of ${cap} ${LABELS[name] || 'items'}. Delete some you don't need to add more.`);
    }
}

module.exports = { assertRoom, CAPS };
