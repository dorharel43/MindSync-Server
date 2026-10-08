// A fake Gemini for local tests: answers by what the prompt asks for, the
// same answer every time (so two code versions can be compared).
const http = require('http');
const log = [];
// Test switches: POST /mode {"check": "fail"|"doubtful"|"ok", "grade": "fail"|"ok"}
const mode = { check: 'ok', grade: 'ok', write: 'ok', replace: 'ok', photo: 'ok', semester: 'none', raw: 'json', fault: 'none', daily: 'ok', recurring: 'base', link: 'ok' };
// fault (3/10, ai-guard): cap | badkey | busy | garbage | cutoff | hang - every model call; /hits counts them
let hits = 0;
let lastDailyPrompt = '';
let linkCalls = 0;
const blueprint = {
  language: 'he', durationMin: 120, materials: 'דף נוסחאות', instructions: 'ענו על כל השאלות', totalPoints: 100,
  questions: [
    { n: 1, points: 50, title: 'נכון / לא נכון', choosePartsCount: 0, parts: [
      { label: '1', type: 'tf', points: 25, topic: 'series', reasonRequired: true },
      { label: '2', type: 'mc', points: 25, topic: 'limits' }], style: 'claims' },
    { n: 2, points: 50, title: 'הוכחה', choosePartsCount: 1, parts: [
      { label: 'א', type: 'open', points: 50, topic: 'proofs' }, { label: 'ב', type: 'open', points: 50, topic: 'proofs' }], style: 'proofs' }
  ],
  recurring: [{ topic: 'series', count: 2, of: 2, example: '∑1/n' }], pool: [{ topic: 'series', type: 'tf', text: '∑1/n converges' }]
};
const exam = {
  title: 'מבחן תרגול', durationMin: 120, materials: 'דף נוסחאות', instructions: 'ענו על הכל',
  questions: [
    { n: 1, title: 'נכון / לא נכון', points: 50, stem: '', choosePartsCount: 0, parts: [
      { label: '1', type: 'tf', text: 'הטור ∑1/n מתכנס.', options: [], correct: 'false', reasonRequired: true, points: 25,
        answer: 'לא נכון: הטור ההרמוני מתבדר.', rubric: [{ criterion: 'הכרעה', points: 5 }, { criterion: 'נימוק', points: 20 }], topic: 'series' },
      { label: '2', type: 'mc', handwritten: true, text: 'lim sin(x)/x כאשר x→0', options: ['0', '1', '∞', 'לא קיים'], correct: '1', points: 25,
        answer: '1', rubric: [{ criterion: 'תשובה', points: 25 }], topic: 'limits' }] },
    { n: 2, title: 'הוכחה', points: 50, stem: 'בחרו סעיף אחד', choosePartsCount: 1, parts: [
      { label: 'א', type: 'open', handwritten: true, text: 'הוכיחו: גזירה ⇒ רציפה', points: 50, answer: 'f(x)−f(x0) = ... → 0', rubric: [{ criterion: 'הוכחה', points: 50 }], topic: 'proofs' },
      { label: 'ב', type: 'open', text: 'הוכיחו את משפט רול', points: 50, answer: 'ויירשטראס ופרמה', rubric: [{ criterion: 'משתמש בוויירשטראס: f מקבלת מקסימום ומינימום בקטע', points: 20 }, { criterion: 'משתמש בפרמה: בנקודת קיצון פנימית f\'=0', points: 20 }, { criterion: 'מטפל במקרה ש-f קבועה', points: 10 }], topic: 'proofs' }] }
  ]
};
// "Circle and explain" in the past exam (fix 1): the mc part needs a reason.
const withReason = (x) => ({ ...x, questions: x.questions.map(q => ({ ...q, parts: q.parts.map(p => p.type === 'mc' ? { ...p, reasonRequired: true, answer: '1, כי sin(x)/x → 1 (גבול ידוע)' } : p) })) });
let lastBlueprintPrompt = '';
function answer(prompt, images) {
  if (/Describe how this course's exam is built/.test(prompt)) lastBlueprintPrompt = prompt;
  // A wrong choice + a photo of the working: where it went wrong.
  if (/answered this exam question wrong/.test(prompt)) {
    if (mode.photo === 'fail') throw new Error('photo down');
    return { feedback: 'בשורה השנייה הצבת x=0 ישירות וקיבלת 0/0=0. זה ביטוי לא מוגדר - הגבול הידוע הוא sin(x)/x → 1.' };
  }
  // Handwriting (item 3): the copy of a photographed answer.
  if (/show a student's handwritten answer/.test(prompt)) {
    if (mode.photo === 'fail') throw new Error('photo down');
    return { text: `f(x) גזירה ב-x0, לכן lim [f(x)−f(x0)] = lim (x−x0)·[f(x)−f(x0)]/(x−x0) = 0·f'(x0) = 0 ⟦?⟧\n(${images} עמודים)`, unsure: ['0·f\'(x0)'], problem: '' };
  }
  // The daily exam question (3/10): one question on the topic it was asked for.
  // mode.daily: ok | garbage (no usable JSON) | two (two questions - only the first is kept)
  if (/Write ONE exam question/.test(prompt)) {
    lastDailyPrompt = prompt;
    if (mode.daily === 'garbage') return { nothing: true };
    const topic = (/the student's weakest one right now: "([^"]*)"/.exec(prompt) || [])[1] || 'כללי';
    const q = (n) => ({ n, title: `שאלה על ${topic}`, points: 20, stem: 'נתונה הסדרה $a_n = \\frac{n}{n+1}$.', choosePartsCount: 0, bonus: n === 2, parts: [
      { label: 'א', type: 'open', handwritten: true, text: 'חשבו את $\\lim_{n \\to \\infty} a_n$.', points: 8, answer: 'מחלקים ב-$n$: $$\\lim \\frac{1}{1 + 1/n} = 1$$', rubric: [{ criterion: 'מחלק ב-$n$', points: 4 }, { criterion: 'מגיע ל-1', points: 4 }], topic },
      { label: 'ב', type: 'open', handwritten: true, text: 'הוכיחו שהסדרה עולה.', points: 12, answer: '$a_{n+1} - a_n = \\frac{1}{(n+1)(n+2)} > 0$', rubric: [{ criterion: 'מחשב את ההפרש', points: 6 }, { criterion: 'מראה שהוא חיובי', points: 6 }], topic }] });
    return { title: `${topic} - שאלת היום`, durationMin: 20, questions: mode.daily === 'two' ? [q(1), q(2)] : [q(1)] };
  }
  // Past exams that print a bonus and "don't know" (the rules test): the
  // blueprint says so - the app checks the words are really in the files.
  if (/Describe how this course's exam is built/.test(prompt) && /הקיפו ונמקו/.test(prompt.split('Return ONLY JSON')[0])) return withReason(blueprint);
  if (/Write a NEW exam/.test(prompt) && /"type":"mc"[^}]*"reasonRequired":true/.test(prompt)) return withReason(exam);
  // "What repeats in the exam" (3/10): a calc2-like analysis (mode.recurring 'calc' | 'none').
  // (of = the files it was given, as a real analysis would; mode.recurringOf overrides it - a wrong AI count)
  // 'list' (7/10): the new shape - which numbered files ask each topic; the app counts.
  // (mode.notThisCourse: file numbers it marks as another course's; mode.listDup: a number twice and one out of range)
  if (/Describe how this course's exam is built/.test(prompt) && mode.recurring === 'list') {
    const n = (prompt.match(/^\d+\. .+$/gm) || []).filter(l => !/^\d+\. (tp|sk)/.test(l)).length;
    const files = [...prompt.split('The files, numbered')[1] ? prompt.split('The files, numbered')[1].split('\n\n')[0].matchAll(/^(\d+)\. /gm) : []].map(m => Number(m[1]));
    const all = files.length ? files : [1, 2];
    return { ...blueprint, notThisCourse: mode.notThisCourse || [], recurring: [
      { topic: 'חישוב נגזרת', exams: mode.listDup ? [...all, all[0], 99] : all, example: "(sin x)'" },
      { topic: 'טורי חזקות: רדיוס ותחום התכנסות', exams: all.slice(0, 2), example: 'רדיוס של Σ x^n/n' },
      { topic: 'נושא במבחן אחד', exams: all.slice(0, 1), example: '' }] };
  }
  if (/Describe how this course's exam is built/.test(prompt) && mode.recurring === 'calc') {
    const of = mode.recurringOf || Math.max(2, (prompt.match(/^=== /gm) || []).length);
    const c = (k) => Math.max(2, Math.min(of, of - k));
    return { ...blueprint, recurring: [
      { topic: 'טורי חזקות: רדיוס ותחום התכנסות', count: of, of, example: 'רדיוס של Σ x^n/n' },
      { topic: 'אינטגרלים לא אמיתיים', count: c(1), of, example: '∫1/x^2 מ-1 עד אינסוף' },
      { topic: 'חישוב גבולות ולופיטל', count: c(1), of, example: 'lim sin x / x' },
      { topic: 'נקודות קיצון בכמה משתנים', count: 2, of, example: 'f(x,y)=x^2+y^2' }] };
  }
  if (/Describe how this course's exam is built/.test(prompt) && mode.recurring === 'none') return { ...blueprint, recurring: [] };
  // The link of topics to skills: a word of the topic in the skill (mode.link 'ok' | 'fail' | 'bogus').
  if (/Its past exams keep asking these TOPICS/.test(prompt)) {
    linkCalls += 1;
    if (mode.link === 'fail') throw new Error('link down');
    const topics = [...prompt.split('The student\'s practice')[0].matchAll(/^\d+\. (.+)$/gm)].map(m => m[1]);
    const skills = [...prompt.matchAll(/^- (.+)$/gm)].map(m => m[1]);
    const words = (x) => x.split(/[\s:,]+/).filter(w => w.length >= 3).map(w => w.replace(/^ה/, '').replace(/ים$|ות$/, ''));
    return { links: topics.map(tp => ({ topic: tp, skills: mode.link === 'bogus' ? ['skill that does not exist'] : skills.filter(sk => words(tp).some(w => sk.includes(w))) })) };
  }
  if (/Describe how this course's exam is built/.test(prompt)) return /בונוס/.test(prompt.split('Return ONLY JSON')[0])
    ? { ...blueprint, bonusQuote: 'שאלת בונוס', dontKnowShare: 0.25, dontKnowQuote: "25% לתשובה 'לא יודע/ת'",
        questions: [...blueprint.questions, { n: 3, points: 10, bonus: true, title: 'בונוס', choosePartsCount: 0, parts: [{ label: '', type: 'open', points: 10, topic: 'hard' }] }] }
    // An AI that invents a bonus the files don't have (must be dropped).
    : /המצאה/.test(prompt) ? { ...blueprint, bonusQuote: 'בונוס', questions: [...blueprint.questions, { n: 3, points: 10, bonus: true, parts: [{ type: 'open', points: 10 }] }] }
    : blueprint;
  // Formulas (2/10): an exam written in LaTeX, with one broken formula.
  if (/Write a NEW exam/.test(prompt) && mode.write === 'latex') return { ...exam, questions: [
    { n: 1, title: 'טורים', points: 50, stem: 'נתון הטור $\\sum_{n=1}^{\\infty} \\frac{1}{n^2}$.', choosePartsCount: 0, parts: [
      { label: 'א', type: 'mc', handwritten: true, text: 'מהו הגבול $\\displaystyle\\lim_{x \\to 0} \\frac{\\sin x}{x}$?', options: ['$0$', '$1$', '$\\infty$', 'לא קיים'], correct: '1', points: 20,
        answer: 'לפי הגבול הידוע $$\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$$', rubric: [{ criterion: 'תשובה', points: 20 }], topic: 'limits' },
      { label: 'ב', type: 'open', handwritten: true, text: 'הוכיחו שאם $\\frac{a_{n+1}}{a_n} \\le \\frac{b_{n+1}}{b_n}$ ו-$\\sum b_n$ מתכנס, אז $\\sum a_n$ מתכנס. שבור: $\\frac{1}{2$', points: 30,
        answer: 'הסדרה $c_n = \\frac{a_n}{b_n}$ יורדת, לכן $$a_n \\le \\frac{a_N}{b_N}\\, b_n$$ ולפי מבחן ההשוואה $\\sum a_n$ מתכנס.',
        rubric: [{ criterion: 'מראה ש-$c_n = \\frac{a_n}{b_n}$ יורדת', points: 15 }, { criterion: 'מבחן ההשוואה ל-$\\sum a_n$', points: 15 }], topic: 'series' }] },
    { n: 2, title: 'קוד', points: 50, stem: '', choosePartsCount: 0, parts: [
      { label: '', type: 'code', text: 'כתבו פונקציה שמחזירה את $n!$:\nint f(int n) { return n; }', points: 50, answer: 'int f(int n) {\n    return n <= 1 ? 1 : n * f(n - 1);\n}', rubric: [{ criterion: 'רקורסיה נכונה', points: 50 }], topic: 'code' }] }
  ] };
  // The writer's multiple choice with no valid answer (fix 5).
  if (/Write a NEW exam/.test(prompt) && mode.write === 'badmc') return { ...exam, questions: exam.questions.map((q, qi) => qi ? q : { ...q, parts: q.parts.map((p, pi) => pi === 1 ? { ...p, correct: '9' } : p) }) };
  if (/Write a NEW exam/.test(prompt)) return /is a BONUS question/.test(prompt)
    ? { ...exam, questions: [...exam.questions, { n: 3, title: 'שאלת בונוס', points: 10, bonus: true, stem: '', choosePartsCount: 0, parts: [
        { label: '', type: 'open', text: 'הוכיחו שהטור ∑1/n² מתכנס ומצאו חסם עליון לסכומו.', points: 10, answer: 'השוואה לטור טלסקופי: הסכום < 2.', rubric: [{ criterion: 'התכנסות', points: 5 }, { criterion: 'חסם', points: 5 }], topic: 'series' }] }] }
    // The writer adds a bonus on its own (no bonus in the structure) - must be dropped.
    : /המצאה/.test(prompt) || /No bonus questions/.test(prompt) && /שאלה 1: נכון/.test(prompt) ? { ...exam, questions: [...exam.questions, { n: 3, title: 'בונוס', points: 10, bonus: true, stem: '', choosePartsCount: 0, parts: [
        { label: '', type: 'open', text: 'x', points: 10, answer: 'y', rubric: [{ criterion: 'z', points: 10 }], topic: 't' }] }] }
    : exam;
  // A replacement part (fix 5): one per <replace>, of the type asked.
  if (/turned out wrong, ambiguous or unsolvable/.test(prompt)) {
    return { parts: [...prompt.matchAll(/<replace q="(\d+)" p="(\d+)" type="(\w+)" points="([\d.]+)"/g)].map(m => {
      const [q, p, type, pts] = [Number(m[1]), Number(m[2]), m[3], Number(m[4])];
      const base = { q, p, type, answer: 'פתרון מלא לסעיף החלופי', rubric: [{ criterion: 'שיטה', points: pts / 2 }, { criterion: 'תוצאה', points: pts / 2 }], topic: 'series' };
      if (type === 'mc') return { ...base, text: 'סעיף חלופי: הגבול של (1+1/n)^n', options: ['1', 'e', '∞'], correct: '1' };
      if (type === 'tf') return { ...base, text: 'סעיף חלופי: הטור ∑1/n² מתכנס.', correct: 'true', reasonRequired: true };
      return { ...base, text: 'סעיף חלופי: הוכיחו שהטור ∑1/2^n מתכנס.' };
    }) };
  }
  if (/Below is an exam with its answer key/.test(prompt) && /סעיף חלופי/.test(prompt)) {
    const parts = [...prompt.matchAll(/<question index="(\d+)">[\s\S]*?<\/question>/g)].flatMap(m =>
      [...m[0].matchAll(/<part index="(\d+)"/g)].map(p => ({ q: Number(m[1]), p: Number(p[1]) })));
    return { parts: parts.map(x => mode.replace === 'bad' ? { ...x, ok: false, problem: 'unsolvable again' } : { ...x, ok: true }) };
  }
  if (/Below is an exam with its answer key/.test(prompt) && mode.check === 'fail') throw new Error('check down');
  if (/You grade one question/.test(prompt) && mode.grade === 'fail') throw new Error('grade down');
  if (/Below is an exam with its answer key/.test(prompt) && mode.check === 'doubtful') {
    const parts = [...prompt.matchAll(/<question index="(\d+)">[\s\S]*?<\/question>/g)].flatMap(m =>
      [...m[0].matchAll(/<part index="(\d+)"/g)].map(p => ({ q: Number(m[1]), p: Number(p[1]) })));
    return { parts: parts.map((x, i) => i === 0 ? { ...x, ok: false, problem: 'unsolvable - the claim is ambiguous' } : i === 1 ? { ...x, ok: false, answer: 'תיקון מאוחר', correct: '1', problem: 'a slip' } : { ...x, ok: true }) };
  }
  if (/Below is an exam with its answer key/.test(prompt)) {
    const parts = [...prompt.matchAll(/<question index="(\d+)">[\s\S]*?<\/question>/g)].flatMap(m =>
      [...m[0].matchAll(/<part index="(\d+)"/g)].map(p => ({ q: Number(m[1]), p: Number(p[1]) })));
    return { parts: parts.map((x, i) => i === 1 && mode.check !== 'allok' ? { ...x, ok: false, answer: 'תיקון: 1 (גבול ידוע)', correct: '1', problem: 'a slip' } : { ...x, ok: true }) };
  }
  if (/You grade one question/.test(prompt)) {
    const idx = [...prompt.matchAll(/<part index="(\d+)"[^>]*points="([\d.]+)"([^>]*)>([\s\S]*?)<\/part>/g)];
    return { parts: idx.map(m => {
      const out = { index: Number(m[1]), points: Number(m[2]) / 2, feedback: 'חצי מהנקודות' };
      if (!/reason="required"/.test(m[3]) || /type="tf"/.test(m[0])) {
        // Points per criterion: the first in full, the rest half - and a total
        // that doesn't match (the app must add the marks up itself).
        const crit = [...m[4].matchAll(/^\[(\d+)\] .*\(([\d.]+)\)$/gm)].map(x => ({ c: Number(x[1]), max: Number(x[2]) }));
        const marks = crit.map((x, k) => ({ c: x.c, points: k === 0 ? (mode.grade === 'over' ? x.max * 3 : x.max) : x.max / 2, note: k === 0 ? '' : (mode.write === 'latex' ? 'חסר $a_n \\le C b_n$' : 'חסר שלב בהוכחה') }));
        if (mode.grade === 'total' || !marks.length) return out;
        if (mode.grade === 'missing') return { ...out, marks: marks.slice(1) };
        return { ...out, points: 999, marks, ...(mode.write === 'latex' ? { feedback: 'הרעיון נכון, אבל צריך להראות ש-$\\frac{a_n}{b_n}$ חסומה.' } : {}) };
      }
      // the reason's class from the reason's words (the code sets the points)
      const r = (/reason: ([\s\S]*?)\n?<\/student_answer>/.exec(m[4]) || [])[1] || '';
      const reason = /מלא/.test(r) ? 'full' : /חלקי/.test(r) ? 'partial' : /ניחוש|שגוי/.test(r) ? 'wrong' : 'partial';
      return { ...out, points: Number(m[2]) * (reason === 'partial' ? 0.4 : 0.95), reason, feedback: `נימוק: ${reason}` };
    }) };
  }
  if (/Write the answer key for this question/.test(prompt)) {
    const idx = [...prompt.matchAll(/<part index="(\d+)" type="(\w+)" points="([\d.]+)"/g)];
    return { parts: idx.map(m => ({ index: Number(m[1]), answer: 'פתרון', rubric: [{ criterion: 'הכל', points: Number(m[3]) }], correct: m[2] === 'tf' ? 'false' : m[2] === 'mc' ? '0' : '', topic: 't' })) };
  }
  if (/A student wrote when their exam\(s\) are/.test(prompt)) {
    const m = /"(\d{1,2})\s*(?:ל|ב)?(ינואר|פברואר|אוקטובר|נובמבר|ספטמבר)/.exec(prompt);
    const months = { ינואר: 1, פברואר: 2, ספטמבר: 9, אוקטובר: 10, נובמבר: 11 };
    return { exams: m ? [{ label: '', date: { day: Number(m[1]), month: months[m[2]], year: null }, time: null }] : [] };
  }
  if (/This is a student's weekly university timetable/.test(prompt)) {
    // A made-up timetable (8 classes) - the shape of a real portal's.
    const exp = [
      { course: 'חדו"א 2', type: 'הרצאה', weekday: 0, start: '08:30', end: '10:00' },
      { course: 'חדו"א 2', type: 'תרגול', weekday: 2, start: '10:15', end: '11:45' },
      { course: 'מבני נתונים', type: 'הרצאה', weekday: 1, start: '12:00', end: '14:00' },
      { course: 'מתמטיקה דיסקרטית 2', type: 'הרצאה', weekday: 3, start: '09:00', end: '11:00' },
      { course: 'מבני נתונים', type: 'תרגול', weekday: 3, start: '14:15', end: '15:45' },
      { course: 'לוגיקה', type: 'הרצאה', weekday: 4, start: '10:00', end: '12:00' },
      { course: 'לוגיקה', type: 'תרגול', weekday: 0, start: '16:00', end: '17:30' },
      { course: 'מסדי נתונים', type: 'הרצאה', weekday: 2, start: '18:00', end: '20:30' }
    ];
    const knownDiscrete = /- מתמטיקה בדידה 2/.test(prompt);
    return { classes: exp.map((c, i) => ({
      course: c.course, type: c.type, weekday: c.weekday,
      // the portal's right-to-left order, read as printed, for half of them
      start: i % 2 ? c.end : c.start, end: i % 2 ? c.start : c.end,
      room: i <= 1 ? 'בניין 7, חדר 101' : '', lecturer: i === 0 ? 'ד"ר כהן' : '',
      everyWeek: i !== 7, note: i === 7 ? 'שעה מאוחרת - כדאי לבדוק' : '',
      match: knownDiscrete && /דיסקרטית/.test(c.course) ? 'מתמטיקה בדידה 2' : (i === 3 ? 'קורס שלא קיים' : '')
    })), semester: mode.semester === 'printed' ? { start: { day: 11, month: 10, year: null }, end: { day: 15, month: 1, year: null } }
        : mode.semester === 'semB' ? { start: { day: 8, month: 3, year: null }, end: null }
        : mode.semester === 'garbage' ? { start: { day: 31, month: 2, year: null }, end: 'soon' } : { start: null, end: null } };
  }
  return { error: 'unknown prompt' };
}
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let text = '';
    try {
      const b = JSON.parse(body || '{}');
      const prompt = (b.contents || []).flatMap(c => c.parts || []).map(p => p.text || '').join('\n');
      if (req.url === '/mode') throw new Error('mode');
      const out = answer(prompt, (b.contents || []).flatMap(c => c.parts || []).filter(p => p.inlineData).length);
      log.push({ url: req.url, kind: prompt.slice(0, 60), pdfs: (b.contents || []).flatMap(c => c.parts || []).filter(p => p.inlineData).length });
      text = JSON.stringify(out);
      // Like Flash on 3/10: LaTeX with a single backslash in the JSON text ("\sum" -> \sum).
      if (mode.raw === 'single') text = text.replace(/\\\\/g, '\\');
    } catch (e) {
      if (/down/.test(e.message)) { res.statusCode = 500; res.end(JSON.stringify({ error: { code: 500, message: e.message } })); return; }
      text = '{}';
    }
    if (req.url === '/log') { res.end(JSON.stringify(log)); return; }
    if (req.url === '/hits') { res.end(JSON.stringify({ hits })); return; }
    if (req.url === '/link-calls') { res.end(JSON.stringify({ linkCalls })); return; }
    if (req.url === '/last-prompt') { res.end(lastBlueprintPrompt); return; }
    if (req.url === '/last-daily') { res.end(JSON.stringify({ prompt: lastDailyPrompt })); return; }
    if (req.url !== '/mode' && mode.fault !== 'none') {
      hits += 1;
      const fail = (code, status, message) => { res.statusCode = code; res.end(JSON.stringify({ error: { code, status, message } })); };
      if (mode.fault === 'cap') return fail(429, 'RESOURCE_EXHAUSTED', 'Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.');
      if (mode.fault === 'badkey') return fail(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.');
      if (mode.fault === 'busy') return fail(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.');
      if (mode.fault === 'hang') return;   // never answers
      const t = mode.fault === 'cutoff' ? text.slice(0, Math.floor(text.length / 2)) : 'Sure! Here is the exam you asked for: (no JSON at all)';
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: mode.fault === 'cutoff' ? 'MAX_TOKENS' : 'STOP' }], usageMetadata: { promptTokenCount: 1000, thoughtsTokenCount: 5000, candidatesTokenCount: 2000 } }));
      return;
    }
    if (req.url !== '/mode') hits += 1;
    if (req.url === '/mode') { Object.assign(mode, JSON.parse(body || '{}')); res.end(JSON.stringify(mode)); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }));
  });
}).listen(Number(process.env.PORT || 9999), '127.0.0.1', () => console.log('fake gemini on', process.env.PORT || 9999));
