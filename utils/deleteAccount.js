// Deletes an account and EVERYTHING that belongs to it (30/9 - shared by
// "Delete account" in Settings and the owner's beta clean-up on /admin).
// Order: the user's data first, the User last - if something fails half way
// the account still exists and it can simply be tried again.
const User = require('../models/User');
const { forgetUser } = require('../middleware/auth');

const MODELS = ['Task', 'Event', 'Folder', 'FileItem', 'StudyItem', 'AiUsage', 'Feedback', 'GoogleLink', 'Settings', 'ActiveDay', 'ExamRun', 'FullExam', 'FullExamRun', 'DailyClaim', 'CourseProfile'];

async function deleteAccount(userId, why = 'by the user') {
  // Google: revoke our access (best effort - Google being down must not keep
  // an account alive). The "MindSync" calendar in their Google account is
  // theirs; it stays.
  try { await require('../rpc/google').disconnect(userId); } catch (err) {
    console.warn('⚠️ Delete account: Google disconnect failed:', err.message);
  }
  await require('../rpc/storage').removeAllForUser(userId);
  const counts = {};
  for (const name of MODELS) {
    const r = await require(`../models/${name}`).deleteMany({ userId });
    counts[name] = r.deletedCount || 0;
  }
  await User.deleteOne({ _id: userId });
  forgetUser(userId);
  console.log(`🗑️ Account deleted (${why}): ${userId} ${JSON.stringify(counts)}`);
  return counts;
}

module.exports = { deleteAccount };
