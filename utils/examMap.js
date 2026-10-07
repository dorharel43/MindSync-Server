// "What repeats in the exam" vs "what you know" (3/10) - see models/CourseProfile.js.
// For each repeating topic of a course's past exams: how often it appears,
// the student's questions on it (by the linked skills) and how they've done
// on them lately. No AI here.

const MIN_ANSWERS = 3;        // fewer: "too few answers", no percentage
const RECENT = 20;            // a topic's last answers that count
const RELINK_AFTER = 5;       // new skills in the course before linking again

const skillOf = (i) => String(i.skillTag || '').trim();

// The course's skills, most used first (what the link call is given).
function courseSkills(items, max = 80) {
  const n = new Map();
  for (const i of items) { const s = skillOf(i); if (s) n.set(s, (n.get(s) || 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([s]) => s);
}

function needsLink(profile, items) {
  if (!profile || !profile.recurring || !profile.recurring.length) return false;
  const skills = courseSkills(items);
  if (!skills.length) return false;
  if (!profile.linkedAt) return true;
  const linkedTopics = new Set((profile.links || []).map(l => l.topic));
  if (profile.recurring.some(r => !linkedTopics.has(r.topic))) return true;   // a new analysis
  const known = new Set(profile.linkedSkills || []);
  return skills.filter(s => !known.has(s)).length >= RELINK_AFTER;
}

// Sorted by value: how often it's in the exam x how far from known. A topic
// with questions but too few answers counts as half known; one with no
// questions at all is listed, but can't be practised (yet).
function topicStats(profile, items) {
  if (!profile || !Array.isArray(profile.recurring)) return [];
  const linkFor = new Map((profile.links || []).map(l => [l.topic, new Set(l.skills || [])]));
  return profile.recurring.map(r => {
    const skills = linkFor.get(r.topic) || new Set();
    const its = items.filter(i => skills.has(skillOf(i)));
    const reviews = its.flatMap(i => (i.reviews || []).filter(rv => !rv.examBlank && rv.reviewedAt))
      .sort((a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt)).slice(0, RECENT);
    const answered = reviews.length;
    const accuracy = answered >= MIN_ANSWERS ? Math.round((reviews.filter(rv => rv.wasCorrect).length / answered) * 100) : null;
    const share = r.of ? Math.min(1, (r.count || 0) / r.of) : 0;
    const weakness = accuracy == null ? 0.5 : 1 - accuracy / 100;
    return {
      topic: r.topic, count: r.count || 0, of: r.of || 0, example: r.example || '',
      skills: [...skills], items: its.length, unseen: its.filter(i => !(i.reviews || []).length).length,
      answered, accuracy, value: Math.round(share * weakness * 100)
    };
  }).sort((a, b) => (b.items ? 1 : 0) - (a.items ? 1 : 0) || b.value - a.value || b.count - a.count);
}

// The one topic where practice pays most today - one that has questions.
function bestTopic(profile, items) {
  const t = topicStats(profile, items).find(x => x.items > 0 && x.value > 0);
  return t ? { topic: t.topic, count: t.count, of: t.of, accuracy: t.accuracy, answered: t.answered, items: t.items, value: t.value, skills: t.skills } : null;
}

module.exports = { topicStats, bestTopic, needsLink, courseSkills, MIN_ANSWERS };
