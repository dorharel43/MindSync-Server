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

  function load() {
    fetch('/api/admin/beta', { headers: { authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (res.status === 401) return message('Your login has expired. <a href="/app/">Log in again</a>, then come back here.');
        if (res.status === 404) return message('This page is only for the app owner.');
        if (!res.ok) return message('Could not load the numbers right now. Try again in a minute.');
        render(await res.json());
      })
      .catch(() => message('Could not reach the server. Try again in a minute.'));
  }
  load();

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
        <td>${u.isYou ? '<span class="no" title="Your own account can\'t be deleted here">you</span>' : `<input type="checkbox" class="pick" value="${esc(u.id)}" aria-label="Choose ${esc(u.email)}">`}</td>
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
        <thead><tr><th><input type="checkbox" id="pick-all" aria-label="Choose everyone except you"></th><th>Name</th><th>Email</th><th>Signed up</th><th>Last active</th><th>Days active</th><th>Came back</th><th>Files</th><th>Questions</th><th>Answers</th><th>Calendar + tasks</th><th>AI this week</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="12" class="no">Nobody yet.</td></tr>'}</tbody>
      </table>
        <div class="bar-actions">
          <button id="del-btn" class="danger" disabled>Delete the chosen accounts</button>
          <span class="hint" id="del-hint">Tick the test accounts to remove. Each one goes with all its data (files, questions, calendar, tasks). Your own account is never deleted here.</span>
        </div></div>
      <h2>The AI answer check vs the students</h2>
      <div class="card">${aiCheck}</div>
      <h2>Latest feedback</h2>
      <div class="card">${fb}</div>`;
    wireDelete();
  }

  // Beta clean-up (30/9): delete chosen test accounts, with all their data.
  function wireDelete() {
    const btn = document.getElementById('del-btn');
    const all = document.getElementById('pick-all');
    const picks = () => [...document.querySelectorAll('.pick')];
    const update = () => {
      const n = picks().filter(p => p.checked).length;
      btn.disabled = n === 0;
      btn.textContent = n ? `Delete ${n} account${n === 1 ? '' : 's'}` : 'Delete the chosen accounts';
      if (all) all.checked = n > 0 && n === picks().length;
    };
    picks().forEach(p => { p.onchange = update; });
    if (all) all.onchange = () => { picks().forEach(p => { p.checked = all.checked; }); update(); };
    btn.onclick = async () => {
      const ids = picks().filter(p => p.checked).map(p => p.value);
      if (!ids.length || btn.disabled) return;
      const typed = window.prompt(`This deletes ${ids.length} account${ids.length === 1 ? '' : 's'} and everything in them. It can't be undone.\n\nType DELETE to confirm:`);
      if (typed !== 'DELETE') return;
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      try {
        const res = await fetch('/api/admin/delete-users', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ ids, confirm: 'DELETE' })
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((out.error && out.error.message) || `HTTP ${res.status}`);
        window.alert(`Deleted ${out.deleted}.${out.skipped ? ` Skipped ${out.skipped} (owner).` : ''}${out.failed ? ` ${out.failed} failed - try again.` : ''}`);
      } catch (err) {
        window.alert(`Could not delete: ${err.message}`);
      }
      load();
    };
  }
})();
