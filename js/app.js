/* App wiring: loading, playback, UI panels, recording and sharing. */
(() => {
  const $ = (s) => document.querySelector(s);
  const canvas = $('#city');
  const city = new CTM.City(canvas);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('ctm:' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('ctm:' + k, JSON.stringify(v)); } catch (_) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem('ctm:' + k); } catch (_) { /* ignore */ } },
  };

  const settings = {
    token: store.get('token', ''),
    remember: !!store.get('token', ''),
    mode: store.get('mode', 'first'),
    limit: store.get('limit', null),
    height: store.get('height', 'lines'),
    sky: store.get('sky2', 'day'),
  };
  const defaultLimit = () => (settings.token ? 300 : 50);

  const app = {
    model: null,
    playing: false,
    speed: 1,
    acc: 0,
    baseRate: 4,
    recorder: null,
    endHold: 0,
    abort: null,
    years: null,
    holdUntil: 0,
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

  /** Per-year summaries: commits, months, new buildings, fires, people. */
  function summarizeYears(m) {
    const years = new Map();
    m.steps.forEach((s, i) => {
      const d = new Date(s.date);
      const y = d.getFullYear();
      if (!years.has(y)) years.set(y, { year: y, first: i, last: i, commits: 0, months: new Array(12).fill(0), added: 0, bugs: 0, authors: new Map(), districts: new Map() });
      const Y = years.get(y);
      Y.last = i;
      Y.commits++;
      Y.months[d.getMonth()]++;
      if (s.bug) Y.bugs++;
      Y.authors.set(s.author, (Y.authors.get(s.author) || 0) + 1);
      for (const op of s.ops) if (op.t === 'a') {
        Y.added++;
        const di = m.lots[op.id].district;
        Y.districts.set(di, (Y.districts.get(di) || 0) + 1);
      }
    });
    return years;
  }

  function yearCard(y, partial) {
    const m = app.model;
    const Y = app.years && app.years.get(y);
    if (!Y) return null;
    let topA = -1, topN = 0;
    Y.authors.forEach((n, a) => { if (n > topN) { topN = n; topA = a; } });
    let busy = 0;
    Y.months.forEach((n, k) => { if (n > Y.months[busy]) busy = k; });
    let topD = -1, topDN = 0;
    Y.districts.forEach((n, d) => { if (n > topDN) { topDN = n; topD = d; } });
    return {
      type: 'year', dur: 4.6, year: y, partial, repo: m.title,
      commits: Y.commits, added: Y.added, bugs: Y.bugs, people: Y.authors.size,
      months: Y.months.slice(), busiest: MONTHS_LONG[busy], busiestN: Y.months[busy],
      top: topA >= 0 ? m.authors[topA].name : '—', topN,
      district: topD >= 0 ? m.districts[topD].name : '—',
    };
  }

  function fullYears(a, b) {
    const d1 = new Date(a), d2 = new Date(b);
    let y = d2.getFullYear() - d1.getFullYear();
    if (d2.getMonth() < d1.getMonth() || (d2.getMonth() === d1.getMonth() && d2.getDate() < d1.getDate())) y--;
    return y;
  }

  /** Called after each played commit: year-end recap and repo birthdays. Returns true to pause the batch. */
  function checkMilestones(res) {
    const m = app.model;
    const i = res.index;
    if (i === 0) return false;
    const prev = m.steps[i - 1], cur = m.steps[i];
    let pause = false;
    const py = new Date(prev.date).getFullYear(), cy = new Date(cur.date).getFullYear();
    if (cy !== py) {
      const card = yearCard(py, false);
      if (card) { city.showCard(card); app.holdUntil = performance.now() + card.dur * 1000; pause = true; }
    }
    const age = fullYears(m.steps[0].date, cur.date);
    if (age >= 1 && age > fullYears(m.steps[0].date, prev.date)) {
      city.showCard({ type: 'birthday', dur: 3.4, age, label: `Happy ${ordinal(age)} birthday, ${m.title.replace(/ \(demo city\)$/, '')}!`, sub: `${age} year${age > 1 ? 's' : ''} since the very first commit` });
    }
    return pause;
  }

  city.sky = settings.sky;
  city.heightMode = settings.height;

  /* ------------------------------------------------------------ helpers */
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const fmtNum = (n) => Math.round(n).toLocaleString();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer = 0;
  function toast(msg, isError = false, ms = 4200) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function computeInsets() {
    const w = window.innerWidth, h = window.innerHeight;
    const ins = { l: 0, r: 0, t: 0, b: 0 };
    const vis = (el) => el && el.offsetParent !== null && getComputedStyle(el).display !== 'none';
    const top = $('.topbar').getBoundingClientRect();
    ins.t = top.bottom + 6;
    const ctr = $('.controls').getBoundingClientRect();
    ins.b = h - ctr.top + 6;
    const st = $('#statsPanel');
    if (vis(st)) {
      const r = st.getBoundingClientRect();
      if (r.width < w * 0.5) ins.l = r.right + 6; else ins.b = Math.max(ins.b, h - r.top + 6);
    }
    const fd = $('#feedPanel');
    if (vis(fd)) ins.r = w - fd.getBoundingClientRect().left + 6;
    city.insets = ins;
  }

  /* ------------------------------------------------------------ loading */
  function showLoader(on, title) {
    $('#loader').hidden = !on;
    if (title) $('#loaderTitle').textContent = title;
    if (on) { $('#loaderBar').style.width = '0%'; $('#loaderMsg').textContent = ''; }
  }

  function useDataset(ds, { autoplay = true } = {}) {
    if (!ds.commits || !ds.commits.length) { toast('That dataset has no commits.', true); return; }
    const model = CTM.buildModel(ds);
    app.model = model;
    city.setModel(model);
    model.seek(-1);
    city.syncToState();
    app.baseRate = Math.max(1.5, Math.min(25, model.steps.length / 45));
    app.years = summarizeYears(model);
    app.holdUntil = 0;
    city.clearCards();
    app.acc = 0;
    $('#scrubber').max = String(model.steps.length - 1);
    $('#scrubber').value = '0';
    $('#repoName').textContent = model.title;
    const meta = [];
    if (model.stars != null) meta.push(`★ ${fmtNum(model.stars)}`);
    meta.push(`${fmtNum(model.steps.length)} commits`);
    if (ds.source === 'github') meta.push(ds.mode === 'latest' ? 'latest history' : 'from the very beginning');
    if (ds.source === 'demo') meta.push('simulated demo');
    $('#repoMeta').textContent = meta.join(' · ');
    $('#tlStart').textContent = fmtDate(model.steps[0].date);
    $('#tlEnd').textContent = fmtDate(model.steps[model.steps.length - 1].date);
    $('#feed').innerHTML = '';
    document.title = `${model.title} · Codebase Time Machine`;
    drawTimeline();
    updateUI(true);
    if (model.warning) toast(model.warning, false, 7000);
    setPlaying(autoplay);
  }

  function loadDemo(autoplay = true) {
    $('#repoInput').value = '';
    useDataset(CTM.makeDemo(), { autoplay });
    history.replaceState(null, '', location.pathname);
  }

  async function loadRepo(input, { fromUrl = false } = {}) {
    const repo = CTM.GitHub.parseRepo(input);
    if (!repo) { toast('Enter a repository like "facebook/react" or paste its GitHub URL.', true); return; }
    $('#repoInput').value = repo;
    const limit = settings.limit || defaultLimit();
    const mode = settings.mode;
    const cacheKey = `cache:${repo.toLowerCase()}:${mode}:${limit}`;
    setPlaying(false);

    const cached = store.get(cacheKey, null);
    if (cached && cached.commits) {
      useDataset(cached);
      toast(`Loaded ${repo} from this browser's cache.`);
      updateShareUrl(repo, mode, limit);
      return;
    }

    if (app.abort) app.abort.abort();
    const ctrl = new AbortController();
    app.abort = ctrl;
    showLoader(true, `Travelling back through ${repo}…`);
    try {
      const ds = await CTM.GitHub.load({
        repo, token: settings.token, mode, limit, signal: ctrl.signal,
        onProgress: (f, msg) => {
          $('#loaderBar').style.width = `${Math.round(f * 100)}%`;
          $('#loaderMsg').textContent = msg;
        },
      });
      showLoader(false);
      useDataset(ds);
      updateShareUrl(repo, mode, limit);
      try {
        const json = JSON.stringify(ds);
        if (json.length < 3_500_000) localStorage.setItem('ctm:' + cacheKey, json);
      } catch (_) { /* cache is optional */ }
    } catch (e) {
      showLoader(false);
      if (e.name === 'AbortError') { toast('Loading cancelled.'); }
      else {
        toast(e.message || 'Something went wrong talking to GitHub.', true, 8000);
        if (e.status === 403 || e.status === 429 || e.status === 401) setTimeout(openSettings, 600);
      }
      if (!app.model || fromUrl) loadDemo();
    } finally {
      if (app.abort === ctrl) app.abort = null;
    }
  }

  function updateShareUrl(repo, mode, limit) {
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('repo', repo);
    if (mode !== 'first') u.searchParams.set('mode', mode);
    u.searchParams.set('n', String(limit));
    history.replaceState(null, '', u.toString());
  }

  /* ------------------------------------------------------------ playback */
  function setPlaying(on) {
    if (!app.model) on = false;
    if (on && app.model.state.index >= app.model.steps.length - 1) {
      app.model.seek(-1);
      city.syncToState();
      $('#feed').innerHTML = '';
    }
    app.playing = on;
    document.body.classList.toggle('playing', on);
  }

  function seekTo(i) {
    if (!app.model) return;
    app.holdUntil = 0;
    city.clearCards();
    app.model.seek(i);
    city.syncToState();
    app.acc = 0;
    rebuildFeed();
    updateUI(true);
  }

  function stepOnce(withEffects) {
    const res = app.model.step();
    if (!res) return null;
    city.onStep(res, withEffects);
    if (withEffects) pushFeed(res.step, res.index);
    return res;
  }

  /* ------------------------------------------------------------ UI panels */
  let lastBugs = -1;
  let lastUI = 0;
  function updateUI(force) {
    const m = app.model;
    if (!m) return;
    const now = performance.now();
    if (!force && now - lastUI < 90) return;
    lastUI = now;
    const st = m.state;
    const i = st.index;
    const s = m.steps[Math.max(0, i)];
    $('#dateLabel').textContent = i < 0 ? 'Before the first commit' : fmtDate(s.date);
    $('#sCommits').textContent = fmtNum(i + 1);
    $('#sFiles').textContent = fmtNum(st.filesAlive);
    $('#sPeople').textContent = fmtNum(st.peopleSeen);
    const bugEl = $('#sBugs');
    bugEl.textContent = fmtNum(st.bugs);
    if (st.bugs !== lastBugs && lastBugs >= 0 && st.bugs > lastBugs) {
      bugEl.classList.remove('bump'); void bugEl.offsetWidth; bugEl.classList.add('bump');
    }
    lastBugs = st.bugs;
    $('#sLines').textContent = fmtNum(Math.max(0, st.lines));
    $('#scrubber').value = String(Math.max(0, i));
    $('#tlPos').textContent = i < 0 ? '' : `#${i + 1} · ${fmtDate(s.date)}`;

    // leaders
    const order = m.authors.map((a, k) => k).filter((k) => st.authorCommits[k] > 0).sort((a, b) => st.authorCommits[b] - st.authorCommits[a]).slice(0, 5);
    const max = order.length ? st.authorCommits[order[0]] : 1;
    $('#leaders').innerHTML = order.map((k) => {
      const a = m.authors[k];
      return `<li><span class="sw" style="background:${a.color}"></span><span class="nm">${esc(a.name)}</span><span class="ct">${st.authorCommits[k]}</span><span></span><span class="barline"><i style="width:${(st.authorCommits[k] / max) * 100}%;background:${a.color}"></i></span></li>`;
    }).join('');

    // districts
    const ds = m.districts.filter((d) => st.districtFiles[d.index] > 0).sort((a, b) => st.districtFiles[b.index] - st.districtFiles[a.index]).slice(0, 5);
    $('#districts').innerHTML = ds.map((d) => `<li><span class="sw" style="background:${d.color}"></span><span class="nm">${esc(d.name)}</span><span class="ct">${st.districtFiles[d.index]}</span></li>`).join('');

    // canvas HUD info
    const last = i >= 0 ? m.steps[i] : null;
    city.hudInfo = {
      repo: m.title,
      date: i < 0 ? '—' : fmtDate(s.date),
      commits: fmtNum(i + 1),
      files: fmtNum(st.filesAlive),
      people: fmtNum(st.peopleSeen),
      bugs: fmtNum(st.bugs),
      lastMsg: last ? last.msg : '',
      lastAuthor: last ? m.authors[last.author].name : '',
      lastColor: last ? m.authors[last.author].color : '#fff',
      lastBug: last ? last.bug : false,
      progress: m.steps.length > 1 ? Math.max(0, i) / (m.steps.length - 1) : 1,
    };
    updateTime(s, i);
    drawTimelineProgress();
  }

  let lastTimeKey = '';
  function updateTime(s, i) {
    const m = app.model;
    if (!app.years) return;
    const d = new Date(s.date);
    const y = d.getFullYear(), mo = d.getMonth();
    // commits so far this year, per month
    const months = new Array(12).fill(0);
    if (i >= 0) {
      for (let k = i; k >= 0; k--) {
        const dk = new Date(m.steps[k].date);
        if (dk.getFullYear() !== y) break;
        months[dk.getMonth()]++;
      }
    }
    $('#sMonth').textContent = fmtNum(i < 0 ? 0 : months[mo]);
    $('#sYear').textContent = fmtNum(months.reduce((a, b) => a + b, 0));
    $('#sMonthName').textContent = i < 0 ? '—' : `${MONTHS_LONG[mo]} ${y}`;
    $('#sYearName').textContent = i < 0 ? '—' : `${y} so far`;
    $('#tmYear').textContent = i < 0 ? '' : String(y);
    const full = app.years.get(y);
    const max = Math.max(1, ...(full ? full.months : months));
    const key = `${y}:${i}`;
    if (key === lastTimeKey) return;
    lastTimeKey = key;
    $('#monthBars').innerHTML = months.map((n, k) => {
      const cls = i < 0 ? 'future' : k === mo ? 'now' : k > mo ? 'future' : '';
      const h = Math.max(3, (n / max) * 54);
      return `<div class="m ${cls}" title="${MONTHS_LONG[k]} ${y}: ${n} commits"><i style="height:${cls === 'future' ? 3 : h}px"></i><b>${MONTHS[k][0]}</b>${k === mo && n && i >= 0 ? `<em style="bottom:${h + 16}px;top:auto">${n}</em>` : ''}</div>`;
    }).join('');
    const ys = [...app.years.values()];
    $('#yearPills').innerHTML = ys.map((Y) => {
      const sofar = Y.year < y ? Y.commits : Y.year === y ? months.reduce((a, b) => a + b, 0) : 0;
      const cls = Y.year === y && i >= 0 ? 'now' : Y.year > y || i < 0 ? 'future' : '';
      return `<button class="${cls}" data-year="${Y.year}" title="Jump to ${Y.year}">${Y.year}<span>${fmtNum(cls === 'future' ? Y.commits : sofar)}</span></button>`;
    }).join('');
  }
  $('#yearPills').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-year]');
    if (!b || !app.years) return;
    const Y = app.years.get(Number(b.dataset.year));
    if (Y) { seekTo(Y.first); toast(`🗓️ Jumped to ${Y.year}: ${fmtNum(Y.commits)} commits that year.`, false, 2500); }
  });

  function feedItem(s, index) {
    const m = app.model;
    const a = m.authors[s.author];
    const li = document.createElement('li');
    if (s.bug) li.className = 'bug';
    const sha = esc(s.sha.slice(0, 7));
    const shaHtml = m.source === 'github' ? `<a class="sha" href="https://github.com/${esc(m.repo)}/commit/${esc(s.sha)}" target="_blank" rel="noopener">${sha}</a>` : `<span class="sha">${sha}</span>`;
    const files = s.merge ? 'merge commit' : `${s.nFiles} file${s.nFiles === 1 ? '' : 's'} changed`;
    li.innerHTML = `<div class="who"><span class="sw" style="background:${a.color}"></span><span>${esc(a.name)}</span>${shaHtml}</div><div class="msg">${s.bug ? '🔥 ' : ''}${esc(s.msg || '(no message)')}</div><div class="files">${files} · ${fmtDate(s.date)}</div>`;
    return li;
  }
  function pushFeed(s, index) {
    const feed = $('#feed');
    feed.prepend(feedItem(s, index));
    while (feed.children.length > 7) feed.lastElementChild.remove();
  }
  function rebuildFeed() {
    const feed = $('#feed');
    feed.innerHTML = '';
    const m = app.model;
    for (let i = Math.max(0, m.state.index - 6); i <= m.state.index; i++) feed.prepend(feedItem(m.steps[i], i));
  }

  /* ------------------------------------------------------------ timeline */
  const tl = $('#timelineCanvas');
  let tlBase = null;
  function drawTimeline() {
    const m = app.model;
    if (!m) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = tl.clientWidth, h = tl.clientHeight;
    if (!w || !h) return;
    tl.width = w * dpr; tl.height = h * dpr;
    const off = document.createElement('canvas');
    off.width = tl.width; off.height = tl.height;
    const c = off.getContext('2d');
    c.scale(dpr, dpr);
    c.fillStyle = 'rgba(255,46,147,0.05)';
    c.fillRect(0, 0, w, h);
    const buckets = Math.max(10, Math.min(Math.floor(w / 3), m.steps.length));
    const act = new Float32Array(buckets), bugs = new Float32Array(buckets);
    m.steps.forEach((s, i) => {
      const b = Math.min(buckets - 1, Math.floor((i / m.steps.length) * buckets));
      act[b] += Math.log2(2 + s.nFiles);
      if (s.bug) bugs[b]++;
    });
    const maxA = Math.max(...act) || 1;
    const bw = w / buckets;
    for (let b = 0; b < buckets; b++) {
      const bh = (act[b] / maxA) * (h - 4);
      c.fillStyle = 'rgba(255,133,194,0.55)';
      c.fillRect(b * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
      if (bugs[b]) {
        c.fillStyle = 'rgba(255,138,0,0.95)';
        c.fillRect(b * bw + 0.5, 0, Math.max(1.5, bw - 1), 4);
      }
    }
    tlBase = off;
    drawTimelineProgress();
  }
  function drawTimelineProgress() {
    const m = app.model;
    if (!m || !tlBase) return;
    const c = tl.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, tl.width, tl.height);
    c.drawImage(tlBase, 0, 0);
    const p = m.steps.length > 1 ? Math.max(0, m.state.index) / (m.steps.length - 1) : 1;
    const g = c.createLinearGradient(0, 0, tl.width, 0);
    g.addColorStop(0, 'rgba(255,46,147,0.25)');
    g.addColorStop(1, 'rgba(200,107,255,0.25)');
    c.fillStyle = g;
    c.fillRect(0, 0, tl.width * p, tl.height);
  }

  /* ------------------------------------------------------------ main loop */
  let lastT = performance.now();
  function loop(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    const m = app.model;
    if (m && app.playing && performance.now() >= app.holdUntil) {
      app.acc += dt * app.baseRate * app.speed;
      const n = Math.floor(app.acc);
      if (n > 0) {
        app.acc -= n;
        for (let k = 0; k < n; k++) {
          const res = stepOnce(k >= n - 3);
          if (!res) break;
          if (checkMilestones(res)) { app.acc = 0; break; }
        }
        updateUI(false);
      }
      if (m.state.index >= m.steps.length - 1) {
        setPlaying(false);
        updateUI(true);
        const lastY = new Date(m.steps[m.steps.length - 1].date).getFullYear();
        const card = yearCard(lastY, true);
        if (card) city.showCard(card);
        if (app.recorder) app.endHold = performance.now() + (card ? card.dur * 1000 + 600 : 2500);
        else celebrate();
      }
    }
    if (app.recorder && app.endHold && performance.now() > app.endHold) stopRecording();
    city.frame(dt);
    requestAnimationFrame(loop);
  }

  function celebrate() {
    const m = app.model;
    if (!m) return;
    const st = m.state;
    toast(`🏙️ ${m.title}: ${fmtNum(st.index + 1)} commits, ${fmtNum(st.filesAlive)} buildings, ${fmtNum(st.peopleSeen)} citizens and ${fmtNum(st.bugs)} fires put out.`, false, 6000);
  }

  /* ------------------------------------------------------------ recording */
  function startRecording() {
    if (!app.model) return;
    if (!canvas.captureStream || typeof MediaRecorder === 'undefined') {
      toast('Your browser cannot record the canvas. Use cinema mode (C) with a screen recorder instead.', true, 6000);
      return;
    }
    const types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const stream = canvas.captureStream(60);
    const chunks = [];
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : undefined);
    } catch (e) {
      toast('Recording is not supported here: ' + e.message, true);
      return;
    }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const type = rec.mimeType || mime || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type });
      download(blob, `${slug()}-city.${ext}`);
      toast(`🎬 Video saved (${(blob.size / 1e6).toFixed(1)} MB). Ready for LinkedIn!`, false, 6000);
    };
    app.recorder = rec;
    app.endHold = 0;
    setCinema(true);
    document.body.classList.add('recording');
    $('#recordBtn .lbl').textContent = 'Stop';
    seekTo(-1);
    setTimeout(() => {
      rec.start(250);
      setTimeout(() => setPlaying(true), 900);
    }, 400);
    toast('Recording from the first commit. It will stop and download at the end. Press Record again to stop early.', false, 4500);
  }

  function stopRecording() {
    const rec = app.recorder;
    app.recorder = null;
    app.endHold = 0;
    document.body.classList.remove('recording');
    $('#recordBtn .lbl').textContent = 'Record';
    setCinema(false);
    if (rec && rec.state !== 'inactive') rec.stop();
  }

  function slug() {
    return (app.model ? app.model.repo : 'city').replace(/[^\w-]+/g, '-').toLowerCase();
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function snapshot() {
    const prev = city.hud;
    city.hud = true;
    city.frame(0);
    canvas.toBlob((b) => {
      if (b) download(b, `${slug()}-city.png`);
      toast('📸 Screenshot saved.');
    }, 'image/png');
    city.hud = prev;
  }

  function setCinema(on) {
    document.body.classList.toggle('cinema', on);
    city.hud = on;
    city.updateAutoCam(false);
  }

  /* ------------------------------------------------------------ settings */
  const dlg = $('#settings');
  function refreshLimitHint() {
    const n = Number($('#limitInput').value);
    $('#limitLabel').textContent = n;
    const reqs = n + Math.ceil(n / 100) + 2;
    $('#limitHint').textContent = settings.token || $('#tokenInput').value
      ? `About ${reqs} API requests (you have 5,000 per hour with a token).`
      : `About ${reqs} API requests. Without a token you get 60 per hour, so keep this near 50.`;
  }
  async function openSettings() {
    $('#tokenInput').value = settings.token;
    $('#rememberToken').checked = settings.remember;
    $('#modeSelect').value = settings.mode;
    $('#limitInput').value = String(settings.limit || defaultLimit());
    $('#heightSelect').value = settings.height;
    $('#skySelect').value = settings.sky;
    refreshLimitHint();
    $('#rateInfo').textContent = '';
    if (!dlg.open) dlg.showModal();
    const rl = await CTM.GitHub.rateLimit(settings.token || $('#tokenInput').value.trim());
    if (rl) {
      const mins = Math.max(0, Math.round((rl.reset * 1000 - Date.now()) / 60000));
      $('#rateInfo').textContent = `GitHub API budget: ${rl.remaining} of ${rl.limit} requests left (resets in ${mins} min).`;
    }
  }
  function saveSettings() {
    const tok = $('#tokenInput').value.trim();
    const hadToken = !!settings.token;
    settings.token = tok;
    settings.remember = $('#rememberToken').checked;
    if (settings.remember && tok) store.set('token', tok); else store.del('token');
    settings.mode = $('#modeSelect').value;
    let lim = Number($('#limitInput').value);
    if (!hadToken && tok && lim === 50) lim = 300;
    settings.limit = lim;
    settings.height = $('#heightSelect').value;
    settings.sky = $('#skySelect').value;
    store.set('mode', settings.mode);
    store.set('limit', settings.limit);
    store.set('height', settings.height);
    store.set('sky2', settings.sky);
    city.heightMode = settings.height;
    city.sky = settings.sky;
  }
  dlg.addEventListener('close', saveSettings);
  $('#limitInput').addEventListener('input', refreshLimitHint);
  $('#tokenInput').addEventListener('input', refreshLimitHint);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#heightSelect').addEventListener('change', () => { city.heightMode = $('#heightSelect').value; });
  $('#skySelect').addEventListener('change', () => { city.sky = $('#skySelect').value; });
  $('#exportBtn').addEventListener('click', () => {
    if (!app.model) return;
    download(new Blob([JSON.stringify(app.model.dataset)], { type: 'application/json' }), `${slug()}-city.json`);
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const ds = JSON.parse(await f.text());
      if (!Array.isArray(ds.commits)) throw new Error('missing "commits" array');
      dlg.close();
      useDataset(ds);
      toast(`Imported ${ds.repo || f.name}.`);
    } catch (err) {
      toast('Could not read that file: ' + err.message, true);
    }
    e.target.value = '';
  });

  /* ------------------------------------------------------------ controls */
  $('#repoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#repoInput').value;
    if (!CTM.GitHub.parseRepo(v) && CTM.Profile.parseUser(v)) loadProfile(v);
    else loadRepo(v);
  });

  /* ------------------------------------------------------------ profile mode */
  const profileEl = $('#profile');
  async function loadProfile(input, { fromUrl = false } = {}) {
    const login = CTM.Profile.parseUser(input);
    if (!login) { toast('That does not look like a GitHub username.', true); return; }
    $('#repoInput').value = login;
    if (app.abort) app.abort.abort();
    const ctrl = new AbortController();
    app.abort = ctrl;
    showLoader(true, `Opening @${login}'s profile…`);
    $('#loaderBar').style.width = '40%';
    try {
      const d = await CTM.Profile.load(login, settings.token, ctrl.signal);
      showLoader(false);
      const card = $('#profileCard');
      card.innerHTML = CTM.Profile.render(d);
      profileEl.hidden = false;
      card.scrollTop = 0;
      CTM.Profile.animateCounts(card);
      const u = new URL(location.href);
      u.search = '';
      u.searchParams.set('user', d.login);
      history.replaceState(null, '', u.toString());
    } catch (e) {
      showLoader(false);
      if (e.name !== 'AbortError') {
        toast(e.message || 'Could not load that profile.', true, 7000);
        if (e.status === 403 || e.status === 429) setTimeout(openSettings, 600);
      }
      if (fromUrl && !app.model) loadDemo();
    } finally {
      if (app.abort === ctrl) app.abort = null;
    }
  }
  function closeProfile() {
    profileEl.hidden = true;
    if (app.model && app.model.source === 'github') updateShareUrl(app.model.repo, settings.mode, settings.limit || defaultLimit());
    else history.replaceState(null, '', location.pathname);
  }
  profileEl.addEventListener('click', (e) => {
    const repoBtn = e.target.closest('[data-repo]');
    if (repoBtn) { profileEl.hidden = true; loadRepo(repoBtn.dataset.repo); return; }
    if (e.target === profileEl || e.target.closest('[data-close]')) closeProfile();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !profileEl.hidden) closeProfile(); });
  document.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.demo) loadDemo();
    else if (b.dataset.user) loadProfile(b.dataset.user);
    else loadRepo(b.dataset.repo);
  }));
  $('#cancelLoad').addEventListener('click', () => { if (app.abort) app.abort.abort(); });
  $('#playBtn').addEventListener('click', () => setPlaying(!app.playing));
  $('#restartBtn').addEventListener('click', () => { seekTo(-1); setPlaying(true); });
  document.querySelectorAll('.speed button').forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
  function setSpeed(s) {
    app.speed = s;
    document.querySelectorAll('.speed button').forEach((x) => x.classList.toggle('on', Number(x.dataset.speed) === s));
  }
  const scrub = $('#scrubber');
  let wasPlaying = false;
  scrub.addEventListener('pointerdown', () => { wasPlaying = app.playing; setPlaying(false); });
  scrub.addEventListener('input', () => seekTo(Number(scrub.value)));
  scrub.addEventListener('change', () => { if (wasPlaying) setPlaying(true); wasPlaying = false; });
  $('#recordBtn').addEventListener('click', () => (app.recorder ? stopRecording() : startRecording()));
  $('#snapBtn').addEventListener('click', snapshot);
  $('#cinemaBtn').addEventListener('click', () => setCinema(!document.body.classList.contains('cinema')));
  $('#shareBtn').addEventListener('click', async () => {
    const url = location.href;
    const text = app.model ? `Watch ${app.model.title} grow into a city, commit by commit: ${url}` : url;
    try {
      await navigator.clipboard.writeText(url);
      toast('🔗 Link copied. Paste it anywhere, it opens straight into this city.');
    } catch (_) {
      toast(text, false, 9000);
    }
  });

  /* ------------------------------------------------------------ canvas input */
  const tip = $('#tooltip');
  let drag = null;
  const pointers = new Map();
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) {
      const prev = pointers.get(e.pointerId);
      if (pointers.size === 2) {
        const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)[1];
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (d0 > 0) city.zoomAt((e.clientX + other.x) / 2, (e.clientY + other.y) / 2, d1 / d0);
      } else if (drag) {
        city.pan(e.clientX - prev.x, e.clientY - prev.y);
        drag.moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      tip.hidden = true;
      return;
    }
    hoverAt(e.clientX, e.clientY);
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) { drag = null; canvas.classList.remove('dragging'); }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; city.hover = -1; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    city.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { city.resetCamera(); toast('Camera follows the city again.', false, 1800); });

  function hoverAt(x, y) {
    const m = app.model;
    if (!m) return;
    const id = city.pick(x, y);
    city.hover = id;
    if (id < 0) { tip.hidden = true; return; }
    const st = m.state;
    const d = m.districts[m.lots[id].district];
    const who = st.lastAuthor[id] >= 0 ? m.authors[st.lastAuthor[id]].name : '—';
    tip.innerHTML = `<b>${esc(m.paths[id])}</b>
      <div class="r">District <span style="color:${d.color}">${esc(d.name)}</span></div>
      <div class="r">${st.alive[id] ? `~${fmtNum(st.size[id])} lines · changed ${st.edits[id]}×` : 'demolished'}</div>
      <div class="r">Last touched by ${esc(who)}</div>
      ${city.fire[id] > 0 ? '<div class="r" style="color:#ffa94d">🔥 Bug being fixed right now</div>' : ''}`;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - tw - 8, x + 14) + 'px';
    tip.style.top = Math.min(window.innerHeight - th - 8, y + 14) + 'px';
  }

  // reveal controls in cinema mode when the mouse nears the bottom
  window.addEventListener('mousemove', (e) => {
    document.body.classList.toggle('show-controls', e.clientY > window.innerHeight - 120 && !app.recorder);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, dialog')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!app.playing); }
    else if (e.key === 'ArrowRight' && app.model) { setPlaying(false); seekTo(app.model.state.index + 1); }
    else if (e.key === 'ArrowLeft' && app.model) { setPlaying(false); seekTo(app.model.state.index - 1); }
    else if (e.key === 'c' || e.key === 'C') setCinema(!document.body.classList.contains('cinema'));
    else if (e.key === 'r' || e.key === 'R') { seekTo(-1); setPlaying(true); }
    else if (e.key === 's' || e.key === 'S') snapshot();
    else if (e.key === '+' || e.key === '=') setSpeed(Math.min(8, app.speed * 2));
    else if (e.key === '-') setSpeed(Math.max(0.5, app.speed / 2));
    else if (e.key === 'Escape' && document.body.classList.contains('cinema') && !app.recorder) setCinema(false);
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { computeInsets(); city.resize(); drawTimeline(); }, 80);
  });

  /* ------------------------------------------------------------ boot */
  computeInsets();
  city.resize();
  requestAnimationFrame(loop);
  document.fonts && document.fonts.ready.then(() => { computeInsets(); drawTimeline(); });

  const params = new URLSearchParams(location.search);
  if (params.get('mode')) settings.mode = params.get('mode') === 'latest' ? 'latest' : 'first';
  if (params.get('n')) settings.limit = Math.max(5, Math.min(3000, Number(params.get('n')) || 50));
  if (params.get('repo')) loadRepo(params.get('repo'), { fromUrl: true });
  else {
    loadDemo(true);
    if (params.get('user')) { const u = params.get('user'); setTimeout(() => loadProfile(u, { fromUrl: true }), 50); }
  }

  // expose for debugging in the console
  window.CTMApp = { app, city, loadRepo, loadDemo, seekTo, updateUI };
})();
