// Forgot password page (/reset-password) - see reset-password.html.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // Same language as the app on this site, else the browser's.
  let lang = 'en';
  try { lang = localStorage.getItem('mindsync.lang') || ''; } catch (e) { lang = ''; }
  if (lang !== 'he' && lang !== 'en') lang = /^(he|iw)/i.test(navigator.language || '') ? 'he' : 'en';

  const HE = {
    askTitle: 'שכחת את הסיסמה?',
    askText: 'כותבים את המייל שאיתו נרשמת, ויישלח אליו קישור לבחירת סיסמה חדשה.',
    email: 'מייל', send: 'שליחת הקישור',
    sentTitle: 'הקישור בדרך',
    sentText: 'אם למייל הזה יש חשבון ב-MindSync, נשלח אליו קישור. זה יכול לקחת דקה - כדאי לבדוק גם בספאם. הקישור תקף לשעה.',
    chooseTitle: 'בחירת סיסמה חדשה',
    chooseText: 'לפחות 8 תווים. כל המכשירים האחרים יתנתקו.',
    newPw: 'סיסמה חדשה', repeatPw: 'שוב את אותה סיסמה', save: 'שמירת הסיסמה החדשה',
    doneTitle: 'הסיסמה הוחלפה',
    doneText: 'אפשר להיכנס עם הסיסמה החדשה - באפליקציה במחשב, או כאן באתר.',
    login: 'כניסה',
    offTitle: 'עוד לא זמין',
    offText: 'איפוס סיסמה במייל עוד לא הוגדר. אפשר לכתוב לנו דרך הגדרות ← עזרה ומשוב באפליקציה, או לפנות למי שהזמין אותך.',
    back: 'חזרה לכניסה',
    // messages
    mismatch: 'שתי הסיסמאות לא זהות.',
    short: 'הסיסמה צריכה להיות לפחות 8 תווים.',
    expired: 'הקישור פג או שכבר השתמשו בו. אפשר לבקש קישור חדש.',
    tooMany: 'יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות.',
    badEmail: 'צריך לכתוב את המייל שאיתו נרשמת.',
    network: 'אין חיבור לשרת. אפשר לנסות שוב בעוד רגע.',
    again: 'בקשת קישור חדש',
    long: 'הסיסמה ארוכה מדי (עד 72 תווים).'
  };
  const EN = {
    mismatch: "The two passwords don't match.",
    short: 'Password must be at least 8 characters.',
    expired: 'This link has expired or was already used. Ask for a new one.',
    tooMany: 'Too many tries. Try again in a few minutes.',
    badEmail: 'Enter the email you signed up with.',
    network: "Can't reach the server. Try again in a moment.",
    again: 'Ask for a new link',
    long: 'Password is too long (72 characters at most).'
  };
  const tr = (k) => (lang === 'he' ? HE[k] : EN[k]);

  if (lang === 'he') {
    document.documentElement.lang = 'he';
    document.documentElement.dir = 'rtl';
    document.title = 'MindSync - איפוס סיסמה';
    document.querySelectorAll('[data-t]').forEach(el => { if (HE[el.dataset.t]) el.textContent = HE[el.dataset.t]; });
  }

  function show(id) {
    ['ask', 'sent', 'choose', 'done', 'off'].forEach(x => { $(x).hidden = x !== id; });
    const first = $(id).querySelector('input');
    if (first) first.focus();
  }
  function error(box, msg) { box.textContent = msg; box.hidden = !msg; }

  async function post(path, body) {
    let res;
    try {
      res = await fetch(`/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { return { status: 0 }; }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data };
  }

  // The token arrives after '#'; take it and clear the address bar so it
  // doesn't stay on screen or in the history.
  const m = /(?:^|[#&])token=([^&]+)/.exec(location.hash || '');
  const token = m ? decodeURIComponent(m[1]) : '';
  if (token && history.replaceState) history.replaceState(null, '', location.pathname);

  // The emailed link opened in a tab that already shows this page: only
  // the part after '#' changes, which doesn't reload - start over with it.
  window.addEventListener('hashchange', () => { if (/token=/.test(location.hash)) location.reload(); });

  if (token) {
    show('choose');
  } else {
    fetch('/api/auth/mail-status').then(r => r.json()).then(d => show(d && d.enabled ? 'ask' : 'off')).catch(() => show('ask'));
  }

  $('ask').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('ask-btn');
    if (btn.disabled) return;
    const email = $('email').value.trim();
    if (!email) return error($('ask-err'), tr('badEmail'));
    btn.disabled = true;
    error($('ask-err'), '');
    const r = await post('forgot-password', { email, lang });
    btn.disabled = false;
    if (r.status === 200) return show('sent');
    if (r.status === 503) return show('off');
    error($('ask-err'), r.status === 0 ? tr('network') : r.status === 429 ? tr('tooMany') : r.status === 400 ? tr('badEmail') : tr('network'));
  });

  $('choose').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('choose-btn');
    if (btn.disabled) return;
    const a = $('pw1').value, b = $('pw2').value;
    if (a.length < 8) return error($('choose-err'), tr('short'));
    if (a !== b) return error($('choose-err'), tr('mismatch'));
    btn.disabled = true;
    error($('choose-err'), '');
    const r = await post('reset-password', { token, password: a });
    btn.disabled = false;
    if (r.status === 200) {
      // This browser may still hold the old login - it no longer works.
      try { localStorage.removeItem('mindsync.token'); } catch (err) { /* blocked */ }
      $('back').hidden = true;
      return show('done');
    }
    const msg = r.data && r.data.error && r.data.error.message ? String(r.data.error.message) : '';
    if (r.status === 400 && /expired|already used/i.test(msg)) {
      error($('choose-err'), tr('expired'));
      if ($('again')) return;
      const again = document.createElement('a');
      again.id = 'again';
      again.href = '/reset-password';
      again.className = 'back';
      again.textContent = tr('again');
      $('choose-err').after(again);
      return;
    }
    error($('choose-err'), r.status === 0 ? tr('network') : r.status === 429 ? tr('tooMany')
      : /too long/i.test(msg) ? tr('long') : /at least 8/i.test(msg) ? tr('short') : tr('network'));
  });
})();
