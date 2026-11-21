/*
 * Turns a list of commits into a city plan (a fixed lot for every file that
 * ever existed, grouped into districts by folder) and a replayable timeline.
 * Because the full plan is known up front, buildings never jump around while
 * the city grows.
 */
window.CTM = window.CTM || {};

CTM.BUG_RE = /\b(fix(e[sd]|ing)?|bug(s|fix)?|crash(es|ed|ing)?|hotfix|regression|broken|segfault|leak(s|ing)?|oops|panic)\b/i;

CTM.PALETTE = [
  '#ff3d9a', '#ff85c2', '#c86bff', '#ffb3d9', '#ff5fae', '#e38bff', '#7fd0ff', '#ff9ccd',
  '#b45cff', '#ff70b8', '#8ee6c8', '#ffc0e0', '#d98cff', '#ff4fa8', '#a6dcff', '#ffd23f',
];
CTM.PEOPLE_COLORS = [
  '#ff2e93', '#a63dff', '#00b386', '#2f8fff', '#ff7a00', '#e0249a', '#7b4dff', '#0aa5c2',
  '#ff4f7a', '#c23bd4', '#3a9d4f', '#d4569c', '#5a6bff', '#ff5ec4', '#8a2be2', '#e8558f',
];

CTM.districtOf = function districtOf(path) {
  const parts = path.split('/');
  if (parts.length === 1) return '(root)';
  const groupers = ['packages', 'apps', 'src', 'lib', 'libs', 'modules', 'services', 'crates', 'components', 'plugins', 'examples', 'tools', 'arch', 'drivers'];
  if (parts.length >= 3 && groupers.includes(parts[0])) return parts[0] + '/' + parts[1];
  return parts[0];
};

CTM.buildModel = function buildModel(ds) {
  const commits = ds.commits; // oldest first

  // ---------- normalise ops ----------
  const pathId = new Map();
  const paths = [];
  const idFor = (p) => {
    let id = pathId.get(p);
    if (id === undefined) { id = paths.length; pathId.set(p, id); paths.push(p); }
    return id;
  };

  const authorId = new Map();
  const authors = [];
  const steps = commits.map((c) => {
    let a = authorId.get(c.author);
    if (a === undefined) {
      a = authors.length;
      authorId.set(c.author, a);
      authors.push({ name: c.author, avatar: c.avatar || null, color: CTM.PEOPLE_COLORS[a % CTM.PEOPLE_COLORS.length] });
    }
    const ops = [];
    for (const f of c.files || []) {
      if (f.s === 'r' && f.from && f.from !== f.p) {
        // move the building: create the new lot (carrying the old size), then demolish the old one
        ops.push({ id: idFor(f.p), t: 'a', add: f.add || 0, del: f.del || 0, carry: f.from });
        ops.push({ id: idFor(f.from), t: 'd' });
      } else {
        ops.push({ id: idFor(f.p), t: f.s === 'a' ? 'a' : f.s === 'd' ? 'd' : 'm', add: f.add || 0, del: f.del || 0 });
      }
    }
    return {
      sha: c.sha,
      msg: c.msg || '',
      author: a,
      date: c.date,
      bug: CTM.BUG_RE.test(c.msg || ''),
      merge: !!c.merge,
      ops,
      nFiles: (c.files || []).length,
    };
  });

  // ---------- districts & layout ----------
  const districtMap = new Map();
  paths.forEach((p, id) => {
    const key = CTM.districtOf(p);
    if (!districtMap.has(key)) districtMap.set(key, { name: key, files: [] });
    districtMap.get(key).files.push(id);
  });

  let districts = [...districtMap.values()];
  districts.sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));
  districts.forEach((d, i) => {
    d.index = i;
    d.color = CTM.PALETTE[i % CTM.PALETTE.length];
    d.files.sort((x, y) => paths[x].localeCompare(paths[y]));
    const n = d.files.length;
    d.cols = Math.max(2, Math.ceil(Math.sqrt(n * 1.3)));
    d.rows = Math.max(2, Math.ceil(n / d.cols));
  });

  // shelf packing into a roughly square map; 2 cells of road between blocks
  const ROAD = 2;
  const area = districts.reduce((s, d) => s + (d.cols + ROAD) * (d.rows + ROAD), 0);
  const maxW = Math.max(Math.ceil(Math.sqrt(area) * 1.15), districts[0] ? districts[0].cols + ROAD : 4);
  let x = ROAD, y = ROAD, shelfH = 0, mapW = 0;
  for (const d of districts) {
    if (x + d.cols + ROAD > maxW + ROAD && x > ROAD) { x = ROAD; y += shelfH + ROAD; shelfH = 0; }
    d.x = x; d.y = y;
    x += d.cols + ROAD;
    shelfH = Math.max(shelfH, d.rows);
    mapW = Math.max(mapW, x);
  }
  const mapH = y + shelfH + ROAD;

  const lots = new Array(paths.length);
  for (const d of districts) {
    d.files.forEach((id, k) => {
      lots[id] = { gx: d.x + (k % d.cols), gy: d.y + Math.floor(k / d.cols), district: d.index };
    });
  }

  // painter's order (back to front)
  const drawOrder = paths.map((_, i) => i).sort((a, b) => {
    const A = lots[a], B = lots[b];
    return (A.gx + A.gy) - (B.gx + B.gy) || A.gx - B.gx;
  });

  // ---------- replay state ----------
  const n = paths.length;
  const state = {
    index: -1,
    size: new Float64Array(n),
    alive: new Uint8Array(n),
    edits: new Uint32Array(n),
    lastAuthor: new Int32Array(n).fill(-1),
    lastTouch: new Int32Array(n).fill(-1000000),
    authorCommits: new Uint32Array(authors.length),
    districtFiles: new Uint32Array(districts.length),
    filesAlive: 0,
    lines: 0,
    bugs: 0,
    peopleSeen: 0,
  };

  function reset() {
    state.index = -1;
    state.size.fill(0); state.alive.fill(0); state.edits.fill(0);
    state.lastAuthor.fill(-1); state.lastTouch.fill(-1000000);
    state.authorCommits.fill(0); state.districtFiles.fill(0);
    state.filesAlive = 0; state.lines = 0; state.bugs = 0; state.peopleSeen = 0;
  }

  function kill(id) {
    if (!state.alive[id]) return;
    state.alive[id] = 0;
    state.filesAlive--;
    state.districtFiles[lots[id].district]--;
    state.lines -= state.size[id];
    state.size[id] = 0;
  }

  /** Apply the next commit. Returns a description of what changed. */
  function step() {
    const i = state.index + 1;
    if (i >= steps.length) return null;
    const s = steps[i];
    state.index = i;
    if (state.authorCommits[s.author] === 0) state.peopleSeen++;
    state.authorCommits[s.author]++;
    if (s.bug) state.bugs++;
    const added = [], touched = [], removed = [];
    for (const op of s.ops) {
      const id = op.id;
      if (op.t === 'd') {
        if (state.alive[id]) { removed.push(id); kill(id); }
        continue;
      }
      let carried = 0;
      if (op.carry) {
        const from = pathId.get(op.carry);
        if (from !== undefined) carried = state.size[from] || 0;
      }
      if (!state.alive[id]) {
        state.alive[id] = 1;
        state.filesAlive++;
        state.districtFiles[lots[id].district]++;
        state.size[id] = 0;
        added.push(id);
      } else {
        touched.push(id);
      }
      const before = state.size[id];
      const after = Math.max(1, before + carried + op.add - op.del);
      state.size[id] = after;
      state.lines += after - before;
      state.edits[id]++;
      state.lastAuthor[id] = s.author;
      state.lastTouch[id] = i;
    }
    return { index: i, step: s, added, touched, removed };
  }

  function seek(target) {
    target = Math.max(-1, Math.min(steps.length - 1, target));
    if (target < state.index) reset();
    while (state.index < target) step();
  }

  return {
    repo: ds.repo,
    title: ds.title || ds.repo,
    description: ds.description || '',
    stars: ds.stars,
    source: ds.source,
    warning: ds.warning || null,
    dataset: ds,
    paths, lots, districts, authors, steps, drawOrder,
    mapW, mapH,
    state, step, seek, reset,
  };
};
