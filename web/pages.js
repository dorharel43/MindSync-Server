// Language for the public pages (home, privacy, terms) - 30/9.
// Each page holds both languages: [data-lang="he"] and [data-lang="en"]
// blocks. The choice is the same one the app uses (localStorage
// mindsync.lang), else the browser's language. Loaded in <head> (it is
// tiny) so the page never shows the wrong language first. Without script,
// the English blocks show.
(function () {
  var KEY = 'mindsync.lang';
  var lang = null;
  try { lang = localStorage.getItem(KEY); } catch (e) { lang = null; }
  if (lang !== 'he' && lang !== 'en') lang = /^(he|iw)/i.test(navigator.language || '') ? 'he' : 'en';
  var root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'he' ? 'rtl' : 'ltr';
  root.classList.add('lang-' + lang);
  document.addEventListener('DOMContentLoaded', function () {
    var title = document.querySelector('meta[name="title-' + lang + '"]');
    if (title) document.title = title.getAttribute('content');
    Array.prototype.forEach.call(document.querySelectorAll('[data-set-lang]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-set-lang') === lang));
      b.addEventListener('click', function () {
        try { localStorage.setItem(KEY, b.getAttribute('data-set-lang')); } catch (e) { /* storage blocked */ }
        location.reload();
      });
    });
  });
})();
