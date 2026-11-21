/*
 * GitHub loader. Uses only the public REST API from the browser:
 *   1. list commits (100 per request)
 *   2. fetch each commit once to learn which files it touched
 * Merge commits are kept in the timeline but not fetched (saves rate limit).
 */
window.CTM = window.CTM || {};

CTM.GitHub = (() => {
  const API = 'https://api.github.com';

  function parseRepo(input) {
    if (!input) return null;
    let s = String(input).trim();
    s = s.replace(/^git@github\.com:/i, '');
    s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
    s = s.replace(/\.git$/i, '').replace(/\/+$/, '');
    const parts = s.split(/[/\s]+/).filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, name] = parts;
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
    return `${owner}/${name}`;
  }

  class GitHubError extends Error {
    constructor(message, status, rate) {
      super(message);
      this.status = status;
      this.rate = rate;
    }
  }

  async function request(path, token, signal) {
    const headers = { Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path.startsWith('http') ? path : API + path, { headers, signal });
    const rate = {
      remaining: Number(res.headers.get('x-ratelimit-remaining')),
      limit: Number(res.headers.get('x-ratelimit-limit')),
      reset: Number(res.headers.get('x-ratelimit-reset')) * 1000,
    };
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch (_) { /* ignore */ }
      if ((res.status === 403 || res.status === 429) && rate.remaining === 0) {
        const mins = Math.max(1, Math.round((rate.reset - Date.now()) / 60000));
        msg = `GitHub rate limit reached. It resets in about ${mins} min. Add a free token in Settings to get 5,000 requests per hour.`;
      } else if (res.status === 404) {
        msg = 'Repository not found. Check the spelling, and note that private repos need a token with access.';
      } else if (res.status === 401) {
        msg = 'That token was rejected by GitHub. Check it in Settings.';
      } else if (res.status === 409) {
        msg = 'This repository is empty.';
      }
      throw new GitHubError(msg, res.status, rate);
    }
    return { data: await res.json(), link: res.headers.get('link') || '', rate };
  }

  function lastPage(link) {
    const m = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
    return m ? Number(m[1]) : 1;
  }

  async function rateLimit(token) {
    try {
      const { data } = await request('/rate_limit', token);
      return data.resources.core;
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {object} opts
   *   repo: "owner/name", token, mode: "first" | "latest", limit: number,
   *   onProgress(fraction, message), signal: AbortSignal
   */
  async function load({ repo, token, mode = 'first', limit = 50, onProgress = () => {}, signal }) {
    const full = parseRepo(repo);
    if (!full) throw new GitHubError('Enter a repository like "facebook/react" or paste its GitHub URL.', 400);

    onProgress(0.02, `Finding ${full}…`);
    const { data: meta } = await request(`/repos/${full}`, token, signal);

    // ---- 1. list commits ----
    const perPage = 100;
    const pagesNeeded = Math.ceil(limit / perPage);
    let listed = [];
    onProgress(0.05, 'Reading the commit history…');
    const first = await request(`/repos/${full}/commits?per_page=${perPage}`, token, signal);
    const total = lastPage(first.link);

    if (mode === 'latest' || total === 1) {
      listed = first.data.slice();
      for (let p = 2; p <= Math.min(total, pagesNeeded); p++) {
        const r = await request(`/repos/${full}/commits?per_page=${perPage}&page=${p}`, token, signal);
        listed = listed.concat(r.data);
      }
      if (mode === 'latest') {
        listed = listed.slice(0, limit).reverse();
      } else {
        listed = listed.reverse().slice(0, limit);
      }
    } else {
      // Walk backwards from the very first page of history.
      const pages = [];
      for (let p = total; p >= 1 && pages.length < pagesNeeded + 1; p--) {
        onProgress(0.05 + 0.05 * (pages.length / (pagesNeeded + 1)), `Rewinding to the first commit (page ${p} of ${total})…`);
        const r = p === 1 ? first : await request(`/repos/${full}/commits?per_page=${perPage}&page=${p}`, token, signal);
        pages.push(r.data);
        const count = pages.reduce((s, x) => s + x.length, 0);
        if (count >= limit) break;
      }
      listed = pages.flat().reverse().slice(0, limit);
    }

    if (!listed.length) throw new GitHubError('No commits found in this repository.', 404);

    // ---- 2. fetch file changes for each commit ----
    const commits = listed.map((c) => ({
      sha: c.sha,
      msg: (c.commit.message || '').split('\n')[0].slice(0, 160),
      author: (c.author && c.author.login) || (c.commit.author && c.commit.author.name) || 'unknown',
      avatar: c.author ? c.author.avatar_url : null,
      date: Date.parse((c.commit.author && c.commit.author.date) || (c.commit.committer && c.commit.committer.date)),
      merge: c.parents && c.parents.length > 1,
      files: [],
    }));

    const todo = commits.filter((c) => !c.merge);
    let done = 0;
    let stoppedEarly = null;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(6, todo.length) }, async () => {
      while (cursor < todo.length && !stoppedEarly) {
        const c = todo[cursor++];
        try {
          const { data } = await request(`/repos/${full}/commits/${c.sha}`, token, signal);
          c.files = (data.files || []).map((f) => {
            const o = { p: f.filename, s: f.status === 'added' ? 'a' : f.status === 'removed' ? 'd' : f.status === 'renamed' ? 'r' : 'm', add: f.additions || 0, del: f.deletions || 0 };
            if (f.previous_filename) o.from = f.previous_filename;
            return o;
          });
          c.loaded = true;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          if (e.status === 403 || e.status === 429) { stoppedEarly = e; break; }
          // a single failing commit should not kill the city
          c.loaded = true;
        }
        done++;
        onProgress(0.1 + 0.88 * (done / todo.length), `Surveying commit ${done} of ${todo.length}…`);
      }
    });
    await Promise.all(workers);

    let result = commits;
    let warning = null;
    if (stoppedEarly) {
      // keep the continuous prefix we managed to load
      const cut = commits.findIndex((c) => !c.merge && !c.loaded);
      result = cut === -1 ? commits : commits.slice(0, cut);
      if (result.length < 3) throw stoppedEarly;
      warning = `GitHub's rate limit stopped the download after ${result.length} commits. Add a token in Settings to see more.`;
    }
    result.forEach((c) => { delete c.loaded; });

    return {
      repo: full,
      title: full,
      description: meta.description || '',
      stars: meta.stargazers_count,
      source: 'github',
      mode,
      totalPages: total,
      commits: result,
      warning,
    };
  }

  return { load, parseRepo, rateLimit, GitHubError };
})();
