/*
 * Demo dataset: a simulated open-source project ("nebula-ui") so the city
 * works instantly, offline and with zero API calls. It is generated from a
 * fixed seed, so every visitor sees the same city.
 */
window.CTM = window.CTM || {};

CTM.makeDemo = function makeDemo() {
  let seed = 20230109;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const people = [
    { name: 'Maya Chen', w: 10, from: 0 },
    { name: 'Leo Okafor', w: 7, from: 0 },
    { name: 'Priya Raman', w: 6, from: 25 },
    { name: 'Sam Rivera', w: 4, from: 60 },
    { name: 'Ines Duarte', w: 3, from: 95 },
    { name: 'Kenji Watanabe', w: 3, from: 140 },
    { name: 'Ava Novak', w: 2, from: 190 },
    { name: 'Omar Haddad', w: 2, from: 230 },
    { name: 'Zoe Fischer', w: 2, from: 270 },
    { name: 'Ravi Patel', w: 1, from: 300 },
    { name: 'Lucia Romero', w: 1, from: 330 },
    { name: 'Theo Martin', w: 1, from: 360 },
  ];

  const areas = [
    { d: 'src/core', ext: '.ts', from: 0, names: ['renderer', 'scheduler', 'reconciler', 'events', 'state', 'router', 'diff', 'hydrate', 'portal', 'context'] },
    { d: 'src/components', ext: '.tsx', from: 4, names: ['Button', 'Modal', 'Navbar', 'Card', 'Tooltip', 'Dropdown', 'Tabs', 'Avatar', 'Sidebar', 'Table', 'Toast', 'DatePicker', 'Slider', 'Badge', 'Accordion', 'Carousel', 'Stepper', 'Popover', 'Drawer', 'Menu'] },
    { d: 'src/hooks', ext: '.ts', from: 20, names: ['useFetch', 'useDebounce', 'useTheme', 'useMedia', 'useStore', 'useToggle', 'useInterval', 'useFocusTrap', 'useHotkeys'] },
    { d: 'src/utils', ext: '.ts', from: 8, names: ['format', 'dates', 'color', 'math', 'dom', 'http', 'cache', 'logger', 'a11y', 'id'] },
    { d: 'tests', ext: '.test.ts', from: 30, names: ['renderer', 'scheduler', 'Button', 'Modal', 'useFetch', 'format', 'router', 'Table', 'a11y', 'snapshot', 'e2e-login', 'e2e-checkout'] },
    { d: 'docs', ext: '.md', from: 45, names: ['intro', 'install', 'api', 'theming', 'faq', 'contributing', 'changelog', 'migration-v2', 'recipes', 'accessibility'] },
    { d: '.github/workflows', ext: '.yml', from: 35, names: ['ci', 'release', 'lint', 'codeql', 'stale'] },
    { d: 'packages/cli/src', ext: '.js', from: 120, names: ['index', 'build', 'serve', 'init', 'config', 'plugins', 'doctor', 'upgrade'] },
    { d: 'packages/icons/svg', ext: '.svg', from: 180, names: ['arrow', 'check', 'close', 'menu', 'search', 'star', 'heart', 'bell', 'user', 'cart', 'home', 'gear', 'sun', 'moon', 'cloud', 'bolt'] },
    { d: 'scripts', ext: '.mjs', from: 90, names: ['bump', 'bench', 'gen-docs', 'clean', 'release-notes'] },
    { d: 'examples/dashboard', ext: '.tsx', from: 220, names: ['App', 'Chart', 'Sidebar', 'KpiCard', 'Filters', 'Header'] },
    { d: 'website/pages', ext: '.mdx', from: 260, names: ['index', 'showcase', 'blog', 'pricing', 'team', 'roadmap'] },
  ];

  const rootFiles = ['README.md', 'package.json', 'LICENSE', 'tsconfig.json', '.gitignore'];
  const lateRoot = [{ p: 'CONTRIBUTING.md', at: 50 }, { p: 'CODE_OF_CONDUCT.md', at: 52 }, { p: 'vite.config.ts', at: 70 }, { p: 'SECURITY.md', at: 200 }];

  const exists = new Map(); // path -> lines
  const remaining = areas.map((a) => a.names.map((n) => `${a.d}/${n}${a.ext}`));
  const N = 420;
  let t = Date.UTC(2023, 0, 9, 10, 0, 0);
  const commits = [];

  const existing = (filter) => {
    const out = [];
    for (const p of exists.keys()) if (!filter || filter(p)) out.push(p);
    return out;
  };
  const pickAuthor = (i) => {
    const pool = people.filter((p) => p.from <= i);
    let total = pool.reduce((s, p) => s + p.w, 0);
    let r = rnd() * total;
    for (const p of pool) { r -= p.w; if (r <= 0) return p.name; }
    return pool[0].name;
  };
  const base = (p) => p.split('/').pop().replace(/\.[^.]+$/, '').replace('.test', '');

  for (let i = 0; i < N; i++) {
    const files = [];
    let msg = '';
    const author = i < 3 ? 'Maya Chen' : pickAuthor(i);

    const add = (p) => {
      if (exists.has(p)) return;
      const lines = p.endsWith('.svg') ? int(8, 30) : p.endsWith('.md') ? int(20, 140) : int(30, 220);
      exists.set(p, lines);
      files.push({ p, s: 'a', add: lines, del: 0 });
    };
    const mod = (p, big) => {
      if (!exists.has(p) || files.some((f) => f.p === p)) return;
      const cur = exists.get(p);
      const addN = big ? int(20, 160) : int(1, 30);
      const delN = Math.min(cur - 5, big ? int(5, 80) : int(0, 18));
      exists.set(p, Math.max(5, cur + addN - Math.max(0, delN)));
      files.push({ p, s: 'm', add: addN, del: Math.max(0, delN) });
    };
    const del = (p) => {
      if (!exists.has(p)) return;
      files.push({ p, s: 'd', add: 0, del: exists.get(p) });
      exists.delete(p);
    };
    const newInOpenArea = () => {
      const open = areas.map((a, k) => k).filter((k) => areas[k].from <= i && remaining[k].length);
      if (!open.length) return null;
      const k = pick(open);
      const idx = Math.floor(rnd() * remaining[k].length);
      return remaining[k].splice(idx, 1)[0];
    };

    if (i === 0) {
      rootFiles.forEach(add);
      add('src/core/renderer.ts');
      add('src/index.ts');
      msg = 'Initial commit: hello, nebula';
    } else {
      for (const lr of lateRoot) if (lr.at === i) add(lr.p);
      const roll = rnd();
      if (roll < 0.34) {
        const n = int(1, i < 60 ? 3 : 2);
        const added = [];
        for (let k = 0; k < n; k++) { const p = newInOpenArea(); if (p) { add(p); added.push(p); } }
        mod('src/index.ts');
        if (added.length) msg = pick([`feat: add ${base(added[0])}`, `Add ${base(added[0])}${added.length > 1 ? ' and friends' : ''}`, `feat(${added[0].split('/')[1] || 'core'}): introduce ${base(added[0])}`]);
        else {
          const p = pick(existing((x) => x.startsWith('src/')));
          mod(p, true);
          msg = `feat: extend ${base(p)} API`;
        }
      } else if (roll < 0.47) {
        const pool = existing((p) => /\.(ts|tsx|js)$/.test(p));
        const n = int(1, 3);
        let first = null;
        for (let k = 0; k < n; k++) { const p = pick(pool); first = first || p; mod(p); }
        msg = pick([
          `fix: ${base(first)} crashes when props are undefined`,
          `Fix memory leak in ${base(first)}`,
          `fix(${base(first)}): off-by-one in pagination`,
          `Hotfix: ${base(first)} broken on Safari`,
          `fix: race condition in ${base(first)}`,
          `Fix regression in ${base(first)} focus handling`,
          `bugfix: ${base(first)} renders twice`,
        ]);
      } else if (roll < 0.66) {
        const pool = existing((p) => p.startsWith('src/'));
        const n = int(3, 7);
        let first = null;
        for (let k = 0; k < n; k++) { const p = pick(pool); first = first || p; mod(p, true); }
        if (rnd() < 0.12) {
          const victims = existing((p) => p.startsWith('src/components') || p.startsWith('src/utils'));
          if (victims.length > 6) { const v = pick(victims); del(v); msg = `refactor: remove deprecated ${base(v)}`; }
        }
        msg = msg || pick([`refactor: simplify ${base(first)}`, `perf: speed up ${base(first)} by 30%`, `Refactor ${base(first)} internals`, `chore: tidy types across core`]);
      } else if (roll < 0.76) {
        const docs = existing((p) => p.startsWith('docs/') || p === 'README.md');
        const p = pick(docs);
        mod(p, rnd() < 0.3);
        if (rnd() < 0.3) { const np = newInOpenArea(); if (np && np.startsWith('docs/')) add(np); }
        msg = pick([`docs: improve ${base(p)}`, 'Update README', `docs: typo in ${base(p)}`, `docs(${base(p)}): add examples`]);
      } else if (roll < 0.86) {
        const tests = existing((p) => p.startsWith('tests/'));
        if (tests.length && rnd() < 0.6) { const p = pick(tests); mod(p); msg = `test: cover ${base(p)} edge cases`; }
        else { const np = newInOpenArea(); if (np) { add(np); msg = `test: add ${base(np)} suite`; } else { mod('package.json'); msg = 'test: bump coverage'; } }
      } else {
        const p = pick(['package.json', 'tsconfig.json', '.gitignore', ...existing((x) => x.startsWith('.github/') || x.startsWith('scripts/'))]);
        mod(p);
        msg = pick(['chore: bump dependencies', 'ci: cache node_modules', 'chore(release): v' + (1 + Math.floor(i / 120)) + '.' + (Math.floor(i / 25) % 10) + '.0', 'build: switch to vite', 'chore: lint fixes']);
        if (/lint fixes/.test(msg)) msg = 'chore: lint cleanup';
      }
      if (!files.length) { mod('README.md'); msg = msg || 'Update README'; }
    }

    commits.push({
      sha: (Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0') + Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0')).slice(0, 12),
      msg,
      author,
      date: t,
      files,
    });
    t += int(2, 46) * 3600 * 1000 + int(0, 59) * 60000;
  }

  return {
    repo: 'nebula-labs/nebula-ui',
    title: 'nebula-ui (demo city)',
    description: 'A simulated project used for the instant demo',
    source: 'demo',
    commits,
  };
};
