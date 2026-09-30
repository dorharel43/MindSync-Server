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
      <h2>AI quality check</h2>
      <div class="card" id="aiq">
        <div class="bar-actions" style="margin-top:0">
          <label>Model <select id="aiq-model"><option value="">loading…</option></select></label>
          <label><input type="checkbox" id="aiq-gen" checked> also test writing questions</label>
          <button id="aiq-run" class="primary">Run the check</button>
        </div>
        <div class="hint">${GRADE_COUNT_HINT}</div>
        <div id="aiq-out"></div>
      </div>
      <h2>Latest feedback</h2>
      <div class="card">${fb}</div>`;
    wireDelete();
    wireAiCheck();
  }

  // ---- AI quality check (30/9) ----------------------------------------------
  // Known answers through the same check students get; a sample lecture
  // through the same question writer. Runs on the server with the real key.
  const GRADE_COUNT_HINT = 'About 33 student answers whose right verdict is known (Hebrew and English: right, half right, numbers in other forms, a wrong AI-written reference, answers that try to fool the check), then a sample lecture through the question writer. One model at a time, no fallback. Takes 1-2 minutes; not counted against anyone\'s AI allowance. Run it again after changing a model or a prompt.';
  const runs = [];
  function wireAiCheck() {
    const sel = document.getElementById('aiq-model');
    const btn = document.getElementById('aiq-run');
    const out = document.getElementById('aiq-out');
    fetch('/api/admin/ai-models', { headers: { authorization: `Bearer ${token}` } }).then(r => r.json()).then(m => {
      const opts = [...(m.gemini || []), ...(m.openrouter || [])];
      sel.innerHTML = opts.length
        ? opts.map(x => `<option value="${esc(x)}"${x === m.current ? ' selected' : ''}>${esc(x)}${x === m.current ? ' (what students get now)' : ''}</option>`).join('')
        : '<option value="">no AI key on the server</option>';
    }).catch(() => { sel.innerHTML = '<option value="">(default)</option>'; });
    if (runs.length) renderRuns(out);
    const auth = { authorization: `Bearer ${token}` };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Starting…';
      try {
        const res = await fetch('/api/admin/ai-check', {
          method: 'POST', headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ model: sel.value || undefined, generation: document.getElementById('aiq-gen').checked })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((d.error && d.error.message) || `HTTP ${res.status}`);
        // It runs on the server; ask how far it got every few seconds.
        for (;;) {
          await sleep(2500);
          const job = await fetch('/api/admin/ai-check', { headers: auth }).then(r => r.json());
          btn.textContent = `Running… ${job.done || 0} of ${job.total || '?'}`;
          if (!job.running) {
            if (job.error) throw new Error(job.error);
            if (job.result) { runs.unshift(job.result); renderRuns(out); }
            break;
          }
        }
      } catch (err) {
        out.innerHTML = `<p class="bad">Could not run the check: ${esc(err.message)}</p>`;
      }
      btn.disabled = false; btn.textContent = 'Run the check';
    };
  }

  function renderRuns(out) {
    const pc = (n, of) => of ? `${Math.round((n / of) * 100)}%` : '-';
    const d = runs[0];
    const s = d.summary;
    const verdictTone = (r) => r.acceptable ? 'yes' : 'bad';
    const misses = d.results.filter(r => !r.acceptable);
    const g = d.generation;
    const compare = runs.length > 1 ? `
      <h3>Runs on this page</h3>
      <div class="tablewrap"><table><thead><tr><th>Model</th><th>Right</th><th>Acceptable</th><th>Too kind</th><th>Too harsh</th><th>Fooled</th><th>Failed</th><th>Median time</th><th>Questions (understanding)</th></tr></thead><tbody>
      ${runs.map(r => `<tr><td>${esc(r.model)}</td><td class="num">${pc(r.summary.exact, r.summary.answered)}</td><td class="num">${pc(r.summary.acceptable, r.summary.answered)}</td><td class="num">${r.summary.tooLenient}</td><td class="num">${r.summary.tooStrict}</td><td class="num">${r.summary.fooled}</td><td class="num">${r.summary.failed}</td><td class="num">${r.summary.medianMs ? (r.summary.medianMs / 1000).toFixed(1) + 's' : '-'}</td><td class="num">${r.generation && !r.generation.error ? `${r.generation.count} (${r.generation.understanding})` : '-'}</td></tr>`).join('')}
      </tbody></table></div>` : '';
    out.innerHTML = `
      <h3>${esc(d.model)} · ${d.seconds}s</h3>
      <div class="tiles">
        <div class="tile"><b>${pc(s.exact, s.answered)}</b><span>exactly the right verdict (${s.exact}/${s.answered})</span></div>
        <div class="tile"><b>${pc(s.acceptable, s.answered)}</b><span>right or defensible</span></div>
        <div class="tile"><b class="${s.tooLenient ? 'bad' : 'yes'}">${s.tooLenient}</b><span>too kind (passed a wrong/half answer - readiness looks better than it is)</span></div>
        <div class="tile"><b class="${s.tooStrict ? 'bad' : 'yes'}">${s.tooStrict}</b><span>too harsh (failed a right answer)</span></div>
        <div class="tile"><b class="${s.fooled ? 'bad' : 'yes'}">${s.fooled}</b><span>fooled by an answer that gives orders</span></div>
        <div class="tile"><b>${s.failed}</b><span>no verdict (error / timeout)</span></div>
        <div class="tile"><b>${s.medianMs ? (s.medianMs / 1000).toFixed(1) + 's' : '-'}</b><span>median time per check</span></div>
      </div>
      <div class="hint">Good enough to launch: 90%+ acceptable, 0 fooled, at most 1 too kind. "Too kind" is the worse mistake - it tells a student they know what they don't.</div>
      ${misses.length ? `<h3>Misses</h3><div class="tablewrap"><table><thead><tr><th>Case</th><th>Question</th><th>Student's answer</th><th>Should be</th><th>Got</th><th>Its feedback</th></tr></thead><tbody>
        ${misses.map(r => `<tr><td>${esc(r.id)}<div class="no">${esc(r.kind)}</div></td><td dir="auto" class="wrap">${esc(r.question)}</td><td dir="auto" class="wrap">${esc(r.answer)}</td><td>${esc(r.expect)}</td><td class="${verdictTone(r)}">${esc(r.got || 'none')}${r.error ? `<div class="no">${esc(r.error)}</div>` : ''}</td><td dir="auto" class="wrap">${esc(r.feedback)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="yes">No misses.</p>'}
      <details><summary>All ${d.results.length} cases</summary><div class="tablewrap"><table><thead><tr><th>Case</th><th>Should be</th><th>Got</th><th>Sure</th><th>Time</th><th>Feedback</th></tr></thead><tbody>
        ${d.results.map(r => `<tr><td>${esc(r.id)}</td><td>${esc(r.expect)}</td><td class="${verdictTone(r)}">${esc(r.got || 'none')}</td><td>${r.sure === false ? 'no' : ''}</td><td class="num">${(r.ms / 1000).toFixed(1)}s</td><td dir="auto" class="wrap">${esc(r.feedback || r.error)}</td></tr>`).join('')}
      </tbody></table></div></details>
      ${g ? (g.error ? `<h3>Writing questions</h3><p class="bad">Failed: ${esc(g.error)}</p>` : `
        <h3>Writing questions (sample lecture on hypothesis testing)</h3>
        <div class="tiles">
          <div class="tile"><b>${g.count}</b><span>questions written (${(g.ms / 1000).toFixed(0)}s)</span></div>
          <div class="tile"><b>${pc(g.understanding, g.count)}</b><span>understanding questions (why / difference / what if) - aim for half or more</span></div>
          <div class="tile"><b>${pc(g.inHebrew, g.count)}</b><span>in Hebrew, like the lecture</span></div>
          <div class="tile"><b>${g.groundedAvg}%</b><span>of answer words come from the lecture (grounded)</span></div>
        </div>
        <details open><summary>The questions</summary><ol class="qs">${g.items.map(it => `<li dir="auto"><b>${esc(it.question)}</b><div class="no">${esc(it.answer)}</div></li>`).join('')}</ol></details>`) : ''}
      ${compare}`;
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
