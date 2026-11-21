/*
 * Profile mode: type a GitHub username instead of a repo and get a
 * pink "developer card" with stats, languages, top repos and recent activity.
 * Costs only 3 to 5 API requests.
 */
window.CTM = window.CTM || {};

CTM.Profile = (() => {
  const LANG_COLORS = ['#ff2e93', '#c86bff', '#ff85c2', '#7fd0ff', '#ffd23f', '#3ccf9a', '#ff9ccd', '#a78bfa'];

  function parseUser(input) {
    if (!input) return null;
    let s = String(input).trim();
    s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/+$/, '').replace(/^@/, '');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(s)) return null;
    return s;
  }

  async function load(login, token, signal) {
    const cacheKey = 'ctm:profile:' + login.toLowerCase();
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (c && Date.now() - c.at < 30 * 60 * 1000) return c.data;
    } catch (_) { /* cache optional */ }

    const req = CTM.GitHub.request;
    let user;
    try {
      user = (await req(`/users/${login}`, token, signal)).data;
    } catch (e) {
      if (e.status === 404) e.message = `No GitHub user or organization called "${login}".`;
      throw e;
    }
    let repos = [];
    const pages = Math.min(3, Math.ceil((user.public_repos || 0) / 100));
    for (let p = 1; p <= pages; p++) {
      const r = await req(`/users/${login}/repos?per_page=100&sort=pushed&page=${p}`, token, signal);
      repos = repos.concat(r.data);
    }
    let events = [];
    try { events = (await req(`/users/${login}/events/public?per_page=40`, token, signal)).data; } catch (_) { /* optional */ }

    const own = repos.filter((r) => !r.fork);
    const stars = own.reduce((s, r) => s + r.stargazers_count, 0);
    const forks = own.reduce((s, r) => s + r.forks_count, 0);
    const langs = new Map();
    for (const r of own) if (r.language) langs.set(r.language, (langs.get(r.language) || 0) + 1 + Math.log2(1 + r.stargazers_count));
    const langTotal = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
    const topLangs = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, w], i) => ({ name, pct: (w / langTotal) * 100, color: LANG_COLORS[i] }));
    const top = own.slice().sort((a, b) => b.stargazers_count - a.stargazers_count || Date.parse(b.pushed_at) - Date.parse(a.pushed_at)).slice(0, 6).map((r) => ({
      full: r.full_name, name: r.name, desc: r.description || '', stars: r.stargazers_count, forks: r.forks_count, lang: r.language, pushed: r.pushed_at,
    }));
    const perYear = new Map();
    for (const r of own) { const y = new Date(r.created_at).getFullYear(); perYear.set(y, (perYear.get(y) || 0) + 1); }
    const years = [...perYear.entries()].sort((a, b) => a[0] - b[0]);

    const data = {
      login: user.login, name: user.name || user.login, avatar: user.avatar_url, bio: user.bio || '', type: user.type,
      location: user.location || '', blog: user.blog || '', company: user.company || '', created: user.created_at,
      followers: user.followers, following: user.following, publicRepos: user.public_repos,
      stars, forks, topLangs, top, years, sampled: repos.length < (user.public_repos || 0),
      events: events.slice(0, 8).map(describeEvent).filter(Boolean),
      eventDays: activityDays(events),
    };
    try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data })); } catch (_) { /* ignore */ }
    return data;
  }

  function activityDays(events) {
    // events per day for the last 14 days
    const days = new Array(14).fill(0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const e of events) {
      const d = new Date(e.created_at); d.setHours(0, 0, 0, 0);
      const ago = Math.round((today - d) / 86400000);
      if (ago >= 0 && ago < 14) days[13 - ago]++;
    }
    return days;
  }

  function describeEvent(e) {
    const repo = e.repo && e.repo.name;
    const p = e.payload || {};
    const at = e.created_at;
    switch (e.type) {
      case 'PushEvent': { const n = p.size || (p.commits || []).length || 1; return { icon: '💗', text: `Pushed ${n} commit${n > 1 ? 's' : ''} to`, repo, at }; }
      case 'CreateEvent': return { icon: '🏗️', text: p.ref_type === 'repository' ? 'Created repository' : `Created ${p.ref_type} in`, repo, at };
      case 'WatchEvent': return { icon: '⭐', text: 'Starred', repo, at };
      case 'ForkEvent': return { icon: '🍴', text: 'Forked', repo, at };
      case 'PullRequestEvent': return { icon: '💌', text: `${cap(p.action || 'updated')} a pull request in`, repo, at };
      case 'IssuesEvent': return { icon: '🎀', text: `${cap(p.action || 'updated')} an issue in`, repo, at };
      case 'IssueCommentEvent': return { icon: '💬', text: 'Commented in', repo, at };
      case 'ReleaseEvent': return { icon: '🚀', text: 'Released a new version of', repo, at };
      case 'PullRequestReviewEvent': return { icon: '👀', text: 'Reviewed a pull request in', repo, at };
      case 'PublicEvent': return { icon: '🌍', text: 'Made public', repo, at };
      default: return { icon: '✨', text: 'Was active in', repo, at };
    }
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function badges(d) {
    const out = [];
    if (d.stars >= 1000) out.push(['🌟', 'Superstar', `${fmt(d.stars)} stars earned`]);
    else if (d.stars >= 50) out.push(['⭐', 'Star Collector', `${fmt(d.stars)} stars earned`]);
    if (d.followers >= 1000) out.push(['👑', 'Icon', `${fmt(d.followers)} followers`]);
    else if (d.followers >= 50) out.push(['🦋', 'Social Butterfly', `${fmt(d.followers)} followers`]);
    if (d.publicRepos >= 30) out.push(['🏙️', 'City Builder', `${d.publicRepos} public repos`]);
    if (d.topLangs.length >= 5) out.push(['💎', 'Polyglot', `${d.topLangs.length}+ languages`]);
    const age = (Date.now() - Date.parse(d.created)) / (365.25 * 86400000);
    if (age >= 8) out.push(['🏛️', 'Legend', `${Math.floor(age)} years on GitHub`]);
    if (d.eventDays.reduce((a, b) => a + b, 0) >= 15) out.push(['🔥', 'On Fire', 'very active this fortnight']);
    if (!out.length) out.push(['🌱', 'Rising Star', 'just getting started']);
    return out.slice(0, 4);
  }

  const fmt = (n) => (n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : Number(n).toLocaleString());
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
    if (s < 86400 * 365) return `${Math.round(s / (86400 * 30))}mo ago`;
    return `${Math.round(s / (86400 * 365))}y ago`;
  }

  function render(d) {
    const since = new Date(d.created);
    const yearsOn = Math.max(0, Math.floor((Date.now() - since) / (365.25 * 86400000)));
    const meta = [
      d.company && `🏢 ${esc(d.company)}`,
      d.location && `📍 ${esc(d.location)}`,
      `🎂 On GitHub since ${since.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}${yearsOn ? ` (${yearsOn} yr${yearsOn > 1 ? 's' : ''})` : ''}`,
    ].filter(Boolean).join('<span class="dot">·</span>');
    const tiles = [
      ['Followers', d.followers, '#ff2e93'], ['Public repos', d.publicRepos, '#c247e8'],
      ['Stars earned', d.stars, '#ff8a00'], ['Forks', d.forks, '#1fb886'], ['Following', d.following, '#7b4dff'],
    ];
    const maxY = Math.max(1, ...d.years.map((y) => y[1]));
    const maxDay = Math.max(1, ...d.eventDays);
    return `
      <button class="pf-close" data-close aria-label="Close">✕</button>
      <div class="pf-hero">
        <div class="pf-avatar"><img src="${esc(d.avatar + (d.avatar.includes('?') ? '&' : '?') + 's=200')}" alt="" referrerpolicy="no-referrer" /><span class="pf-spark s1">✦</span><span class="pf-spark s2">✧</span><span class="pf-spark s3">✦</span></div>
        <div class="pf-id">
          <div class="pf-kicker">${d.type === 'Organization' ? 'Organization' : 'Developer'} profile</div>
          <h2>${esc(d.name)}</h2>
          <a class="pf-login" href="https://github.com/${esc(d.login)}" target="_blank" rel="noopener">@${esc(d.login)}</a>
          ${d.bio ? `<p class="pf-bio">${esc(d.bio)}</p>` : ''}
          <div class="pf-meta">${meta}</div>
          <div class="pf-badges">${badges(d).map(([i, t, s]) => `<span class="pf-badge" title="${esc(s)}">${i} ${esc(t)}</span>`).join('')}</div>
        </div>
      </div>
      <div class="pf-tiles">${tiles.map(([k, v, c], i) => `<div class="pf-tile" style="--c:${c};animation-delay:${i * 60}ms"><b data-count="${v}">0</b><span>${k}</span></div>`).join('')}</div>
      <div class="pf-grid">
        <section>
          <h3>Top languages</h3>
          ${d.topLangs.length ? `<div class="pf-langbar">${d.topLangs.map((l) => `<i style="width:${l.pct}%;background:${l.color}" title="${esc(l.name)} ${l.pct.toFixed(0)}%"></i>`).join('')}</div>
          <ul class="pf-langs">${d.topLangs.map((l) => `<li><i style="background:${l.color}"></i>${esc(l.name)}<span>${l.pct.toFixed(0)}%</span></li>`).join('')}</ul>` : '<p class="muted small">No languages detected yet.</p>'}
          <h3>Repos created per year</h3>
          <div class="pf-years">${d.years.map(([y, n]) => `<div title="${y}: ${n} repos"><i style="height:${Math.max(4, (n / maxY) * 60)}px"></i><em>${n}</em><b>'${String(y).slice(2)}</b></div>`).join('') || '<p class="muted small">No repos yet.</p>'}</div>
          <h3>Last 14 days</h3>
          <div class="pf-days">${d.eventDays.map((n) => `<i style="opacity:${n ? 0.3 + 0.7 * (n / maxDay) : 0.12}" title="${n} events"></i>`).join('')}</div>
        </section>
        <section>
          <h3>Most-starred repos <span class="muted small">tap one to build its city ✨</span></h3>
          <div class="pf-repos">${d.top.map((r) => `
            <button class="pf-repo" data-repo="${esc(r.full)}">
              <div class="pf-repo-top"><b>${esc(r.name)}</b><span>⭐ ${fmt(r.stars)}</span></div>
              <p>${esc(r.desc || 'No description')}</p>
              <div class="pf-repo-meta">${r.lang ? `<span>${esc(r.lang)}</span>` : ''}<span>🍴 ${fmt(r.forks)}</span><span>updated ${ago(r.pushed)}</span><span class="go">Build city →</span></div>
            </button>`).join('') || '<p class="muted small">No public repos yet.</p>'}</div>
          <h3>Recent activity</h3>
          <ul class="pf-events">${d.events.map((e) => `<li><span class="ic">${e.icon}</span><span>${esc(e.text)} <b>${esc(e.repo || '')}</b></span><time>${ago(e.at)}</time></li>`).join('') || '<li class="muted">No public activity lately.</li>'}</ul>
        </section>
      </div>
      ${d.sampled ? '<p class="muted small pf-note">Stats are based on the 300 most recently active repos.</p>' : ''}`;
  }

  function animateCounts(root) {
    const els = root.querySelectorAll('[data-count]');
    const t0 = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / 900);
      const e = 1 - Math.pow(1 - k, 3);
      els.forEach((el) => { el.textContent = fmt(Math.round(Number(el.dataset.count) * e)); });
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  return { parseUser, load, render, animateCounts };
})();
