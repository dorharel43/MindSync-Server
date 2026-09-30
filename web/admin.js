// The owner's beta page (/admin) - see admin.html. A separate file so the
// page works under the site's security policy (no inline scripts).
(function () {
  const root = document.getElementById('root');
  const sub = document.getElementById('sub');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (iso) => iso ? `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}` : '-';
  const message = (html) => { sub.textContent = ''; root.innerHTML = `<div class="msg">${html}</div>`; };

  let token = null;
  try { token = localStorage.getItem('mindsync.token'); } catch (e) { /* storage blocked */ }
  if (!token) { message('Log in to MindSync on this site first: <a href="/app/">open the app</a>, then come back here.'); return; }

  fetch('/api/admin/beta', { headers: { authorization: `Bearer ${token}` } })
    .then(async (res) => {
      if (res.status === 401) return message('Your login has expired. <a href="/app/">Log in again</a>, then come back here.');
      if (res.status === 404) return message('This page is only for the app owner.');
      if (!res.ok) return message('Could not load the numbers right now. Try again in a minute.');
      render(await res.json());
    })
    .catch(() => message('Could not reach the server. Try again in a minute.'));

  function render(d) {
    const s = d.summary;
    sub.textContent = `Today is ${short(d.today)}. Days are counted in Israel time. Your account id (for ADMIN_USER_IDS): ${d.you}`;
    const tiles = [
      [s.users, 'signed up'],
      [s.newThisWeek, 'new this week'],
      [s.activeToday, 'active today'],
      [s.activeThisWeek, 'active this week'],
      [s.cameBack, 'came back on another day'],
      [s.answersThisWeek, 'questions answered this week'],
      [s.aiToday.heavy + s.aiToday.light, `AI requests today (${s.aiToday.heavy} file jobs)`]
    ];
    const max = Math.max(1, ...d.daily.map(x => x.active));
    const chart = d.daily.map(x => `
      <div class="col" title="${x.active} active, ${x.answers} answers">
        <div class="n">${x.active || ''}</div>
        <div class="bar" style="height:${Math.round((x.active / max) * 100)}%"></div>
        <div class="d">${short(x.day)}</div>
      </div>`).join('');
    const rows = d.users.map(u => `
      <tr>
        <td dir="auto">${esc(u.name) || '<span class="no">-</span>'}</td>
        <td>${esc(u.email)}</td>
        <td class="num">${short(u.signedUp)}</td>
        <td class="num">${short(u.lastActive)}</td>
        <td class="num">${u.daysActive}</td>
        <td>${u.cameBack ? '<span class="yes">yes</span>' : '<span class="no">no</span>'}</td>
        <td class="num">${u.files}</td>
        <td class="num">${u.questions}</td>
        <td class="num">${u.answers} <span class="no">(${u.answersWeek} this week)</span></td>
        <td class="num">${u.tasks + u.events}</td>
        <td class="num">${u.aiWeek}</td>
      </tr>`).join('');
    // How often students disagreed with the AI check (30/9).
    const c = s.aiCheck || { checked: 0, agreed: 0, stricter: 0, kinder: 0 };
    const pct = (n) => c.checked ? Math.round((n / c.checked) * 100) : 0;
    const aiCheck = c.checked
      ? `<div class="tiles">
          <div class="tile"><b>${c.checked}</b><span>answers the AI checked (30 days)</span></div>
          <div class="tile"><b>${pct(c.agreed)}%</b><span>students kept the AI's call</span></div>
          <div class="tile"><b>${pct(c.stricter)}%</b><span>marked themselves lower (the check was too kind?)</span></div>
          <div class="tile"><b>${pct(c.kinder)}%</b><span>marked themselves higher (the check was too harsh?)</span></div>
        </div>
        <div class="hint">${c.checked < 50 ? 'Still few answers - wait for about 50 before reading much into this. ' : ''}If either "marked themselves" number goes past ~10%, the check's instructions need a look.</div>`
      : '<div class="no">No checked answers yet.</div>';
    const fb = d.feedback.length
      ? d.feedback.map(f => `<div class="fb"><div class="meta">${esc(new Date(f.at).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }))} · ${esc(f.from)}${f.page ? ' · ' + esc(f.page) : ''}</div><div class="text" dir="auto">${esc(f.text)}</div></div>`).join('')
      : '<div class="no">No feedback yet.</div>';

    root.innerHTML = `
      <div class="tiles">${tiles.map(([n, l]) => `<div class="tile"><b>${n}</b><span>${esc(l)}</span></div>`).join('')}</div>
      <h2>People active each day (last 14 days)</h2>
      <div class="card"><div class="chart">${chart}</div>
        <div class="hint">Active = opened the app while logged in, answered a question or used the AI that day.</div></div>
      <h2>Everyone who signed up</h2>
      <div class="card tablewrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Signed up</th><th>Last active</th><th>Days active</th><th>Came back</th><th>Files</th><th>Questions</th><th>Answers</th><th>Calendar + tasks</th><th>AI this week</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="11" class="no">Nobody yet.</td></tr>'}</tbody>
      </table></div>
      <h2>The AI answer check vs the students</h2>
      <div class="card">${aiCheck}</div>
      <h2>Latest feedback</h2>
      <div class="card">${fb}</div>`;
  }
})();
