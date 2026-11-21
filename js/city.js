/*
 * Isometric city renderer (plain Canvas 2D, no dependencies).
 * Buildings = files, fires = bug-fix commits, little people = contributors.
 */
window.CTM = window.CTM || {};

(() => {
  const TW = 40; // tile width in world units
  const TH = 20; // tile height
  const MAX_H = 190;

  const iso = (gx, gy) => [(gx - gy) * TW / 2, (gx + gy) * TH / 2];

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const shade = (c, f) => [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];
  const hash = (a, b, c) => {
    let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  const SPARKLE_NIGHT = ['255,255,255', '255,214,240', '214,236,255', '220,255,240', '255,248,200', '232,214,255'];
  const SPARKLE_DAY = ['255,46,147', '255,210,63', '200,107,255', '255,133,194', '255,180,0', '255,255,255'];

  const SKY = {
    night: { top: '#1f1846', mid: '#4b3f8f', bottom: '#e59ac8', ground: [62, 52, 118], road: [44, 36, 90], plotA: 0.16, light: 0.98, tree: [140, 230, 190] },
    day: { top: '#ffc4e1', mid: '#ffe3f1', bottom: '#fff8fc', ground: [255, 236, 246], road: [255, 196, 224], plotA: 0.28, light: 1.0, tree: [70, 205, 150] },
  };

  class City {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.model = null;
      this.sky = 'day';
      this.heightMode = 'lines';
      this.cam = { x: 0, y: 0, zoom: 1 };
      this.camTarget = { x: 0, y: 0, zoom: 1 };
      this.autoCam = true;
      this.insets = { l: 0, r: 0, t: 0, b: 0 };
      this.hud = false;
      this.hudInfo = null;
      this.hover = -1;
      this.particles = [];
      this.beams = [];
      this.people = [];
      this.cards = [];
      this.confetti = [];
      this.time = 0;
      this.stars = Array.from({ length: 160 }, (_, i) => ({ x: hash(i, 1, 7), y: hash(i, 2, 7) * 0.7, r: 0.4 + hash(i, 3, 7) * 1.3, p: hash(i, 4, 7) * 6.28 }));
      this.resize();
    }

    /* ---------------- setup ---------------- */
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.dpr = dpr;
      this.w = this.canvas.clientWidth || window.innerWidth;
      this.h = this.canvas.clientHeight || window.innerHeight;
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      if (this.model) this.updateAutoCam(true);
    }

    setModel(model) {
      this.model = model;
      const n = model.paths.length;
      this.curH = new Float32Array(n);
      this.flash = new Float32Array(n);
      this.fire = new Float32Array(n);
      this.particles = [];
      this.beams = [];
      this.people = model.authors.map((a, i) => ({
        i, name: a.name, color: hexToRgb(a.color), colorStr: a.color,
        x: 0, y: 0, tx: 0, ty: 0, alpha: 0, active: -1e9, lastSeen: -1e9, phase: hash(i, 9, 9) * 6.28, wanderAt: 0, spawned: false,
      }));
      this.districtColors = model.districts.map((d) => hexToRgb(d.color));
      this.autoCam = true;
      this.updateAutoCam(true);
    }

    targetHeight(id) {
      const st = this.model.state;
      if (!st.alive[id]) return 0;
      if (this.heightMode === 'churn') return Math.min(MAX_H, 10 + Math.sqrt(st.edits[id]) * 16);
      const sz = st.size[id];
      return Math.min(MAX_H, 8 + Math.log2(1 + sz) * 6 + Math.sqrt(sz) * 0.9);
    }

    /** Snap visuals to the model state (after seeking). */
    syncToState() {
      const m = this.model;
      for (let id = 0; id < m.paths.length; id++) {
        this.curH[id] = this.targetHeight(id);
        this.flash[id] = 0;
        this.fire[id] = 0;
      }
      this.particles = [];
      this.beams = [];
      const idx = m.state.index;
      for (const p of this.people) {
        p.spawned = false;
        p.alpha = 0;
        p.active = -1e9;
      }
      // place recently active contributors near their last building
      const seen = new Map();
      for (let i = idx; i >= 0 && i > idx - 40; i--) {
        const s = m.steps[i];
        if (seen.has(s.author)) continue;
        const target = s.ops.find((o) => m.state.alive[o.id]);
        seen.set(s.author, true);
        const p = this.people[s.author];
        const pt = target ? this.lotFront(target.id) : this.randomRoadPoint();
        p.x = p.tx = pt[0] + (Math.random() - 0.5) * 20;
        p.y = p.ty = pt[1] + (Math.random() - 0.5) * 10;
        p.spawned = true;
        p.alpha = 1;
        p.active = i;
        p.lastSeen = this.time;
      }
      this.updateAutoCam(true);
    }

    lotFront(id) {
      const l = this.model.lots[id];
      return iso(l.gx + 0.5, l.gy + 1.15);
    }
    lotTop(id) {
      const l = this.model.lots[id];
      const [x, y] = iso(l.gx + 0.5, l.gy + 0.5);
      return [x, y - this.curH[id]];
    }
    randomRoadPoint() {
      const m = this.model;
      const edge = Math.floor(Math.random() * 4);
      const t = Math.random();
      const g = edge === 0 ? [t * m.mapW, 0.5] : edge === 1 ? [m.mapW - 0.5, t * m.mapH] : edge === 2 ? [t * m.mapW, m.mapH - 0.5] : [0.5, t * m.mapH];
      return iso(g[0], g[1]);
    }

    /* ---------------- events from playback ---------------- */
    onStep(res, withEffects) {
      if (!res) return;
      const m = this.model;
      const s = res.step;
      const p = this.people[s.author];
      const ids = res.added.concat(res.touched);
      if (!withEffects) return;

      for (const id of res.added) { this.flash[id] = 1; this.pendingSparkle = this.pendingSparkle || []; this.pendingSparkle.push([id, 0.25]); }
      for (const id of res.touched) this.flash[id] = Math.max(this.flash[id], 0.75);
      for (const id of res.removed) {
        const [x, y] = iso(m.lots[id].gx + 0.5, m.lots[id].gy + 0.5);
        for (let k = 0; k < 10; k++) this.particles.push({ x: x + (Math.random() - 0.5) * 16, y: y - Math.random() * 10, vx: (Math.random() - 0.5) * 20, vy: -10 - Math.random() * 20, life: 0, max: 1 + Math.random(), size: 3 + Math.random() * 4, kind: 'dust' });
      }
      if (s.bug) {
        for (const id of ids.slice(0, 6)) this.fire[id] = 2.6 + Math.random() * 0.8;
      }

      // walk the contributor to the building they changed
      if (ids.length) {
        const target = ids[0];
        const front = this.lotFront(target);
        if (!p.spawned) {
          const start = this.randomRoadPoint();
          p.x = start[0]; p.y = start[1];
          p.spawned = true;
        }
        p.tx = front[0] + (Math.random() - 0.5) * 14;
        p.ty = front[1] + (Math.random() - 0.5) * 6;
        p.active = res.index;
        p.lastSeen = this.time;
        p.wanderAt = this.time + 2 + Math.random() * 2;
        for (const id of ids.slice(0, 3)) this.beams.push({ p: s.author, id, t: 0, color: p.color, bug: s.bug });
      }
      if (this.beams.length > 60) this.beams.splice(0, this.beams.length - 60);
    }

    /* ---------------- camera ---------------- */
    worldBounds(onlyAlive) {
      const m = this.model;
      let minGx = Infinity, minGy = Infinity, maxGx = -Infinity, maxGy = -Infinity, maxH = 40;
      if (onlyAlive) {
        const st = m.state;
        for (let id = 0; id < m.paths.length; id++) {
          if (!st.alive[id]) continue;
          const l = m.lots[id];
          if (l.gx < minGx) minGx = l.gx;
          if (l.gy < minGy) minGy = l.gy;
          if (l.gx > maxGx) maxGx = l.gx;
          if (l.gy > maxGy) maxGy = l.gy;
          const h = this.targetHeight(id);
          if (h > maxH) maxH = h;
        }
      }
      if (!isFinite(minGx)) {
        minGx = 0; minGy = 0; maxGx = m.mapW; maxGy = m.mapH;
      } else {
        // pad and keep a minimum footprint so the first commit isn't absurdly zoomed
        const minSpan = 9;
        const cx = (minGx + maxGx + 1) / 2, cy = (minGy + maxGy + 1) / 2;
        const sx = Math.max(maxGx - minGx + 3, minSpan), sy = Math.max(maxGy - minGy + 3, minSpan);
        minGx = cx - sx / 2; maxGx = cx + sx / 2; minGy = cy - sy / 2; maxGy = cy + sy / 2;
        maxH = Math.max(maxH, 60);
      }
      const pts = [iso(minGx, minGy), iso(maxGx, minGy), iso(minGx, maxGy), iso(maxGx, maxGy)];
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys) - maxH, y1: Math.max(...ys) };
    }

    updateAutoCam(snap) {
      if (!this.model || !this.autoCam) return;
      const b = this.worldBounds(true);
      const ins = this.hud ? { l: 0, r: 0, t: 70, b: 60 } : this.insets;
      const aw = Math.max(100, this.w - ins.l - ins.r), ah = Math.max(100, this.h - ins.t - ins.b);
      const zoom = Math.min(aw / (b.x1 - b.x0), ah / (b.y1 - b.y0)) * 0.88;
      const z = Math.max(0.08, Math.min(zoom, 2.6));
      // camera centre in world coords such that the bounds centre lands at the centre of the free area
      const cxScreen = ins.l + aw / 2, cyScreen = ins.t + ah / 2;
      const wx = (b.x0 + b.x1) / 2 - (cxScreen - this.w / 2) / z;
      const wy = (b.y0 + b.y1) / 2 - (cyScreen - this.h / 2) / z;
      this.camTarget = { x: wx, y: wy, zoom: z };
      if (snap) this.cam = { ...this.camTarget };
    }

    toWorld(sx, sy) {
      return [(sx - this.w / 2) / this.cam.zoom + this.cam.x, (sy - this.h / 2) / this.cam.zoom + this.cam.y];
    }

    zoomAt(sx, sy, factor) {
      this.autoCam = false;
      const [wx, wy] = this.toWorld(sx, sy);
      const z = Math.max(0.05, Math.min(6, this.cam.zoom * factor));
      this.cam.zoom = z;
      this.cam.x = wx - (sx - this.w / 2) / z;
      this.cam.y = wy - (sy - this.h / 2) / z;
    }

    pan(dx, dy) {
      this.autoCam = false;
      this.cam.x -= dx / this.cam.zoom;
      this.cam.y -= dy / this.cam.zoom;
    }

    resetCamera() {
      this.autoCam = true;
      this.updateAutoCam(false);
    }

    pick(sx, sy) {
      if (!this.model) return -1;
      const [wx, wy] = this.toWorld(sx, sy);
      const m = this.model;
      const order = m.drawOrder;
      for (let k = order.length - 1; k >= 0; k--) {
        const id = order[k];
        const h = this.curH[id];
        if (h < 1) continue;
        const l = m.lots[id];
        const [x, y] = iso(l.gx + 0.5, l.gy + 0.5);
        const hw = TW / 2 * 0.8, hh = TH / 2 * 0.8;
        if (wx < x - hw || wx > x + hw || wy > y + hh || wy < y - hh - h) continue;
        // refine with the diamond footprint at the bottom
        const dy = wy - y;
        if (dy > 0 && Math.abs(wx - x) / hw + dy / hh > 1) continue;
        if (wy < y - h && Math.abs(wx - x) / hw + Math.abs(wy - (y - h)) / hh > 1) continue;
        return id;
      }
      return -1;
    }

    /* ---------------- frame ---------------- */
    frame(dt) {
      if (!this.model) return this.drawSkyOnly();
      this.time += dt;
      const m = this.model;
      const n = m.paths.length;

      // animate heights / flashes / fires
      const k = 1 - Math.exp(-dt * 7);
      for (let id = 0; id < n; id++) {
        const t = this.targetHeight(id);
        const c = this.curH[id];
        if (c !== t) this.curH[id] = Math.abs(t - c) < 0.2 ? t : c + (t - c) * k;
        if (this.flash[id] > 0) this.flash[id] = Math.max(0, this.flash[id] - dt * 1.3);
        if (this.fire[id] > 0) {
          this.fire[id] -= dt;
          if (this.curH[id] > 1 && Math.random() < dt * 40) this.emitFire(id);
          if (this.fire[id] <= 0) { this.emitSmoke(id, 6); this.emitSparkles(id, 10); }
        }
      }

      // camera
      if (this.autoCam) {
        if ((this._camTick = (this._camTick || 0) + 1) % 10 === 0) this.updateAutoCam(false);
        const ck = 1 - Math.exp(-dt * 2.2);
        this.cam.x += (this.camTarget.x - this.cam.x) * ck;
        this.cam.y += (this.camTarget.y - this.cam.y) * ck;
        this.cam.zoom += (this.camTarget.zoom - this.cam.zoom) * ck;
      }

      // sparkle bursts once a new building has risen a little
      if (this.pendingSparkle && this.pendingSparkle.length) {
        const keep = [];
        for (const ps of this.pendingSparkle) { ps[1] -= dt; if (ps[1] <= 0) this.emitSparkles(ps[0], 6); else keep.push(ps); }
        this.pendingSparkle = keep;
      }
      // ambient glitter drifting over the city
      if (Math.random() < dt * 6 && m.state.filesAlive) {
        const id = Math.floor(Math.random() * n);
        if (this.curH[id] > 4) {
          const [x, y] = this.lotTop(id);
          this.particles.push({ x: x + (Math.random() - 0.5) * 30, y: y - Math.random() * 30, vx: 0, vy: -6, life: 0, max: 1.4 + Math.random(), size: 4 + Math.random() * 4, kind: 'sparkle', c: Math.floor(Math.random() * 6) });
        }
      }
      this.updateCards(dt);
      this.updatePeople(dt);
      this.updateParticles(dt);
      this.draw();
    }

    emitFire(id) {
      const [x, y] = this.lotTop(id);
      for (let i = 0; i < 2; i++) {
        this.particles.push({ x: x + (Math.random() - 0.5) * 18, y: y + 2 - Math.random() * 4, vx: (Math.random() - 0.5) * 10, vy: -30 - Math.random() * 35, life: 0, max: 0.5 + Math.random() * 0.5, size: 4 + Math.random() * 6, kind: 'flame' });
      }
      if (Math.random() < 0.35) this.particles.push({ x, y: y - 10, vx: (Math.random() - 0.5) * 8, vy: -18 - Math.random() * 10, life: 0, max: 1.8 + Math.random(), size: 5 + Math.random() * 5, kind: 'smoke' });
      if (Math.random() < 0.2) this.particles.push({ x, y, vx: (Math.random() - 0.5) * 60, vy: -40 - Math.random() * 50, life: 0, max: 0.7, size: 1.5, kind: 'spark' });
    }
    emitSparkles(id, n) {
      if (this.curH[id] < 1) return;
      const [x, y] = this.lotTop(id);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = 20 + Math.random() * 40;
        this.particles.push({ x, y: y - 4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6 - 25, life: 0, max: 0.9 + Math.random() * 0.8, size: 3 + Math.random() * 4, kind: 'sparkle', c: Math.floor(Math.random() * 6) });
      }
    }
    sparkle(ctx, x, y, r, a, c) {
      ctx.fillStyle = `rgba(${c},${a})`;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.quadraticCurveTo(x, y, x, y + r);
      ctx.quadraticCurveTo(x, y, x - r, y);
      ctx.quadraticCurveTo(x, y, x, y - r);
      ctx.fill();
    }
    emitSmoke(id, n) {
      const [x, y] = this.lotTop(id);
      for (let i = 0; i < n; i++) this.particles.push({ x: x + (Math.random() - 0.5) * 16, y: y - Math.random() * 8, vx: (Math.random() - 0.5) * 10, vy: -12 - Math.random() * 14, life: 0, max: 1.6 + Math.random() * 1.2, size: 4 + Math.random() * 6, kind: 'smoke' });
    }

    updateParticles(dt) {
      const ps = this.particles;
      let w = 0;
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        p.life += dt;
        if (p.life >= p.max) continue;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.kind === 'spark') p.vy += 90 * dt;
        if (p.kind === 'smoke') p.vx += Math.sin(this.time * 2 + i) * 4 * dt;
        if (p.kind === 'sparkle') { p.vx *= 1 - dt * 2; p.vy *= 1 - dt * 2; }
        ps[w++] = p;
      }
      ps.length = Math.min(w, 2500);
      for (const b of this.beams) b.t += dt;
      this.beams = this.beams.filter((b) => b.t < 0.9);
    }

    updatePeople(dt) {
      const m = this.model;
      const idx = m.state.index;
      for (const p of this.people) {
        if (!p.spawned) continue;
        const dx = p.tx - p.x, dy = p.ty - p.y;
        const d = Math.hypot(dx, dy);
        const speed = 90 + Math.min(d, 400) * 0.9;
        p.moving = d > 1.5;
        if (p.moving) {
          const s = Math.min(d, speed * dt);
          p.x += dx / d * s;
          p.y += dy / d * s;
          p.phase += dt * 14;
        } else if (this.time > p.wanderAt) {
          p.tx = p.x + (Math.random() - 0.5) * 50;
          p.ty = p.y + (Math.random() - 0.5) * 25;
          p.wanderAt = this.time + 2 + Math.random() * 4;
        }
        // fade out contributors who have gone quiet for a while
        const quiet = idx - p.active;
        const targetA = quiet > 80 ? 0 : 1;
        p.alpha += (targetA - p.alpha) * Math.min(1, dt * 2);
        if (p.alpha < 0.02 && targetA === 0) p.spawned = false;
      }
    }

    /* ---------------- drawing ---------------- */
    drawBackground(ctx) {
      const sky = SKY[this.sky];
      const g = ctx.createLinearGradient(0, 0, 0, this.h);
      g.addColorStop(0, sky.top);
      g.addColorStop(0.55, sky.mid);
      g.addColorStop(1, sky.bottom);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
      if (this.sky === 'day') {
        const sg = ctx.createRadialGradient(this.w * 0.8, this.h * 0.15, 0, this.w * 0.8, this.h * 0.15, 320);
        sg.addColorStop(0, 'rgba(255,255,255,0.85)');
        sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(0, 0, this.w, this.h);
        for (const s of this.stars) {
          if (s.r < 0.8) continue;
          const a = 0.35 + 0.35 * Math.sin(this.time * 1.8 + s.p);
          this.sparkle(ctx, s.x * this.w, s.y * this.h, s.r * 3.4 * (0.6 + 0.4 * Math.sin(this.time * 2 + s.p)), a, s.p > 4 ? '255,210,63' : s.p > 2 ? '200,107,255' : '255,46,147');
        }
      }
      if (this.sky === 'night') {
        for (const s of this.stars) {
          const a = 0.35 + 0.35 * Math.sin(this.time * 1.5 + s.p);
          if (s.r > 1.45) {
            this.sparkle(ctx, s.x * this.w, s.y * this.h, s.r * 3.2 * (0.6 + 0.4 * Math.sin(this.time * 2 + s.p)), a + 0.25, s.p > 3 ? '255,214,240' : '214,236,255');
          } else {
            ctx.fillStyle = `rgba(255,240,252,${a})`;
            ctx.beginPath();
            ctx.arc(s.x * this.w, s.y * this.h, s.r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        // soft moon glow
        const mg = ctx.createRadialGradient(this.w * 0.5, this.h * 1.05, 0, this.w * 0.5, this.h * 1.05, Math.max(this.w, this.h) * 0.75);
        mg.addColorStop(0, 'rgba(255,190,225,0.35)');
        mg.addColorStop(0.45, 'rgba(200,180,255,0.12)');
        mg.addColorStop(1, 'rgba(200,180,255,0)');
        ctx.fillStyle = mg;
        ctx.fillRect(0, 0, this.w, this.h);
        const cg = ctx.createRadialGradient(this.w * 0.85, this.h * 0.12, 0, this.w * 0.85, this.h * 0.12, 260);
        cg.addColorStop(0, 'rgba(255,250,235,0.35)');
        cg.addColorStop(0.15, 'rgba(255,240,250,0.18)');
        cg.addColorStop(1, 'rgba(190,220,255,0)');
        ctx.fillStyle = cg;
        ctx.fillRect(0, 0, this.w, this.h);
      }
    }

    drawSkyOnly() {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.time += 1 / 60;
      this.drawBackground(ctx);
    }

    diamond(ctx, gx0, gy0, gx1, gy1) {
      const a = iso(gx0, gy0), b = iso(gx1, gy0), c = iso(gx1, gy1), d = iso(gx0, gy1);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
      ctx.closePath();
    }

    draw() {
      const ctx = this.ctx;
      const m = this.model;
      const st = m.state;
      const sky = SKY[this.sky];
      const night = this.sky === 'night';
      const z = this.cam.zoom;

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawBackground(ctx);

      ctx.setTransform(this.dpr * z, 0, 0, this.dpr * z, this.dpr * (this.w / 2 - this.cam.x * z), this.dpr * (this.h / 2 - this.cam.y * z));

      // ground slab
      const slab = 0.6;
      this.diamond(ctx, -slab, -slab, m.mapW + slab, m.mapH + slab);
      ctx.fillStyle = rgb(sky.road);
      ctx.fill();
      // slab edge (gives the island some thickness)
      {
        const l = iso(-slab, m.mapH + slab), b = iso(m.mapW + slab, m.mapH + slab), r = iso(m.mapW + slab, -slab);
        const depth = 14;
        ctx.beginPath();
        ctx.moveTo(l[0], l[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(b[0], b[1] + depth); ctx.lineTo(l[0], l[1] + depth); ctx.closePath();
        ctx.fillStyle = night ? rgb(shade(sky.road, 0.7)) : '#ff9fcd'; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(b[0], b[1]); ctx.lineTo(r[0], r[1]); ctx.lineTo(r[0], r[1] + depth); ctx.lineTo(b[0], b[1] + depth); ctx.closePath();
        ctx.fillStyle = night ? rgb(shade(sky.road, 0.5)) : '#ff6fb3'; ctx.fill();
      }

      // road markings between blocks
      ctx.strokeStyle = night ? 'rgba(255,220,245,0.25)' : 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.2 / Math.max(z, 0.5);
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      for (const d of m.districts) {
        const a = iso(d.x - 1, d.y - 1), b = iso(d.x + d.cols + 1, d.y - 1);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        const c = iso(d.x - 1, d.y + d.rows + 1);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // district plots + trees on unused lots
      for (const d of m.districts) {
        const col = this.districtColors[d.index];
        this.diamond(ctx, d.x - 0.15, d.y - 0.15, d.x + d.cols + 0.15, d.y + d.rows + 0.15);
        ctx.fillStyle = rgb(mix(sky.ground, col, night ? 0.22 : 0.35), 1);
        ctx.fill();
        const glowA = night ? 0.7 : 0.75;
        ctx.strokeStyle = rgb(col, st.districtFiles[d.index] > 0 ? glowA : 0.12);
        ctx.lineWidth = 1.5 / Math.max(z, 0.6);
        ctx.stroke();
      }
      for (const d of m.districts) {
        const used = d.files.length;
        for (let k = used; k < d.cols * d.rows; k++) {
          const gx = d.x + (k % d.cols), gy = d.y + Math.floor(k / d.cols);
          this.drawTree(ctx, gx + 0.5, gy + 0.5, sky.tree, d.index * 31 + k);
        }
      }

      // buildings
      const order = m.drawOrder;
      for (let k = 0; k < order.length; k++) {
        const id = order[k];
        const h = this.curH[id];
        if (h < 0.6) {
          continue;
        }
        this.drawBuilding(ctx, id, h, night, z);
      }

      // beams (contributor -> building)
      const glowMode = night ? 'lighter' : 'source-over';
      ctx.globalCompositeOperation = glowMode;
      for (const b of this.beams) {
        const p = this.people[b.p];
        if (!p || !p.spawned || this.curH[b.id] < 1) continue;
        const [tx, ty] = this.lotTop(b.id);
        const a = Math.max(0, 1 - b.t / 0.9);
        const col = b.bug ? (night ? [255, 170, 200] : [255, 120, 40]) : b.color;
        ctx.strokeStyle = rgb(col, 0.65 * a);
        ctx.lineWidth = 2.2 / Math.max(z, 0.4);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 14);
        ctx.quadraticCurveTo((p.x + tx) / 2, Math.min(p.y, ty) - 40, tx, ty);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';

      // people
      for (const p of this.people) if (p.spawned && p.alpha > 0.02) this.drawPerson(ctx, p, z);

      // particles
      for (const p of this.particles) {
        const t = p.life / p.max;
        if (p.kind === 'smoke') {
          ctx.fillStyle = night ? `rgba(150,150,170,${0.28 * (1 - t)})` : `rgba(200,150,185,${0.3 * (1 - t)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + t * 1.6), 0, Math.PI * 2); ctx.fill();
        } else if (p.kind === 'dust') {
          ctx.fillStyle = `rgba(190,170,140,${0.45 * (1 - t)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + t), 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalCompositeOperation = glowMode;
      for (const p of this.particles) {
        const t = p.life / p.max;
        if (p.kind === 'flame') {
          const c = night ? (t < 0.3 ? [255, 246, 200] : t < 0.6 ? [255, 190, 150] : [255, 120, 175])
            : (t < 0.3 ? [255, 214, 60] : t < 0.6 ? [255, 120, 40] : [255, 46, 147]);
          ctx.fillStyle = rgb(c, 0.85 * (1 - t));
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - t * 0.6), 0, Math.PI * 2); ctx.fill();
        } else if (p.kind === 'spark') {
          ctx.fillStyle = `rgba(255,220,120,${1 - t})`;
          ctx.fillRect(p.x, p.y, 2, 2);
        } else if (p.kind === 'sparkle') {
          const tw = Math.sin(t * Math.PI);
          this.sparkle(ctx, p.x, p.y, p.size * (0.4 + tw) * (night ? 1 : 1.25), 0.95 * tw, (night ? SPARKLE_NIGHT : SPARKLE_DAY)[p.c]);
        }
      }
      // fire glow
      for (let id = 0; id < this.fire.length; id++) {
        if (this.fire[id] <= 0 || this.curH[id] < 1) continue;
        const [x, y] = this.lotTop(id);
        const r = 46 + Math.sin(this.time * 20 + id) * 4;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, night ? 'rgba(255,170,190,0.55)' : 'rgba(255,150,60,0.35)');
        g.addColorStop(1, night ? 'rgba(255,140,200,0)' : 'rgba(255,46,147,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      // district labels
      if (z > 0.22) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fs = Math.max(9, Math.min(15, 12 / z));
        ctx.font = `600 ${fs}px Inter, sans-serif`;
        for (const d of m.districts) {
          if (!st.districtFiles[d.index]) continue;
          if (d.files.length < 3 && z < 0.6) continue;
          const [x, y] = iso(d.x + d.cols / 2, d.y + d.rows + 0.9);
          const label = d.name;
          const w = ctx.measureText(label).width + 12 / z * 0.8;
          ctx.fillStyle = night ? 'rgba(34,24,72,0.82)' : 'rgba(255,255,255,0.85)';
          const ph = fs * 1.5;
          this.roundRect(ctx, x - w / 2, y - ph / 2, w, ph, ph / 2);
          ctx.fill();
          ctx.fillStyle = night ? d.color : rgb(shade(hexToRgb(d.color), 0.62));
          ctx.fillText(label, x, y + 0.5);
        }
      }

      // hover outline
      if (this.hover >= 0 && this.curH[this.hover] > 0.6) {
        const id = this.hover;
        const l = m.lots[id];
        const h = this.curH[id];
        const inset = 0.1;
        const pts = [iso(l.gx + inset, l.gy + inset), iso(l.gx + 1 - inset, l.gy + inset), iso(l.gx + 1 - inset, l.gy + 1 - inset), iso(l.gx + inset, l.gy + 1 - inset)];
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 / z;
        ctx.beginPath();
        ctx.moveTo(pts[3][0], pts[3][1]); ctx.lineTo(pts[0][0], pts[0][1] - h); ctx.lineTo(pts[1][0], pts[1][1] - h); ctx.lineTo(pts[2][0], pts[2][1] - h); ctx.lineTo(pts[3][0], pts[3][1] - h); ctx.closePath();
        ctx.moveTo(pts[3][0], pts[3][1] - h); ctx.lineTo(pts[3][0], pts[3][1]);
        ctx.moveTo(pts[2][0], pts[2][1] - h); ctx.lineTo(pts[2][0], pts[2][1]); ctx.lineTo(pts[3][0], pts[3][1]);
        ctx.moveTo(pts[2][0], pts[2][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.lineTo(pts[1][0], pts[1][1] - h);
        ctx.stroke();
      }

      // screen-space overlay
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      // vignette
      const vg = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.35, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, night ? 'rgba(20,12,50,0.45)' : 'rgba(255,120,190,0.12)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, this.w, this.h);
      if (this.hud && this.hudInfo) this.drawHud(ctx);
      this.drawConfetti(ctx);
      if (this.cards.length) this.drawCard(ctx, this.cards[0]);
    }

    drawTree(ctx, gx, gy, col, seed) {
      const [x, y] = iso(gx, gy);
      const s = 0.7 + hash(seed, 3, 1) * 0.5;
      const ox = (hash(seed, 1, 1) - 0.5) * 10, oy = (hash(seed, 2, 1) - 0.5) * 4;
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(x + ox, y + oy + 1, 6 * s, 3 * s, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgb(shade(col, 0.8));
      ctx.beginPath(); ctx.moveTo(x + ox - 5 * s, y + oy); ctx.lineTo(x + ox, y + oy - 16 * s); ctx.lineTo(x + ox + 5 * s, y + oy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = rgb(shade(col, 1.15));
      ctx.beginPath(); ctx.moveTo(x + ox, y + oy); ctx.lineTo(x + ox, y + oy - 16 * s); ctx.lineTo(x + ox + 5 * s, y + oy); ctx.closePath(); ctx.fill();
    }

    drawBuilding(ctx, id, h, night, z) {
      const m = this.model;
      const l = m.lots[id];
      const base = this.districtColors[l.district];
      const light = SKY[this.sky].light;
      const fl = this.flash[id];
      const onFire = this.fire[id] > 0;
      const inset = 0.12;
      const A = iso(l.gx + inset, l.gy + inset); // back
      const B = iso(l.gx + 1 - inset, l.gy + inset); // right
      const C = iso(l.gx + 1 - inset, l.gy + 1 - inset); // front
      const D = iso(l.gx + inset, l.gy + 1 - inset); // left

      let top = shade(base, 1.15 * light), left = shade(base, 0.82 * light), right = shade(base, 0.58 * light);
      if (onFire) {
        const f = 0.35 + 0.15 * Math.sin(this.time * 25 + id);
        top = mix(top, [255, 160, 180], f); left = mix(left, [240, 120, 160], f); right = mix(right, [200, 90, 140], f);
      }
      if (fl > 0) {
        const t = fl * 0.85;
        top = mix(top, [255, 255, 255], t); left = mix(left, [235, 240, 255], t * 0.8); right = mix(right, [210, 220, 255], t * 0.7);
      }

      // shadow
      ctx.fillStyle = night ? 'rgba(0,0,0,0.28)' : 'rgba(220,40,140,0.12)';
      const sh = Math.min(h * 0.35, 30);
      ctx.beginPath();
      ctx.moveTo(B[0], B[1]); ctx.lineTo(B[0] + sh, B[1] + sh * 0.5); ctx.lineTo(C[0] + sh, C[1] + sh * 0.5); ctx.lineTo(C[0], C[1]); ctx.closePath();
      ctx.fill();

      // left face
      ctx.fillStyle = rgb(left);
      ctx.beginPath();
      ctx.moveTo(D[0], D[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(C[0], C[1] - h); ctx.lineTo(D[0], D[1] - h); ctx.closePath();
      ctx.fill();
      // right face
      ctx.fillStyle = rgb(right);
      ctx.beginPath();
      ctx.moveTo(C[0], C[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(B[0], B[1] - h); ctx.lineTo(C[0], C[1] - h); ctx.closePath();
      ctx.fill();
      // roof
      ctx.fillStyle = rgb(top);
      ctx.beginPath();
      ctx.moveTo(A[0], A[1] - h); ctx.lineTo(B[0], B[1] - h); ctx.lineTo(C[0], C[1] - h); ctx.lineTo(D[0], D[1] - h); ctx.closePath();
      ctx.fill();

      // windows
      if (h * z > 22 && h > 18) {
        const rows = Math.floor((h - 10) / 9);
        ctx.lineWidth = 2.6;
        ctx.lineCap = 'butt';
        const glow = ['rgba(255,252,235,0.95)', 'rgba(255,225,245,0.95)', 'rgba(225,245,255,0.95)'];
        const lit = night ? glow[id % 3] : 'rgba(255,255,255,0.92)';
        const dim = night ? 'rgba(60,45,110,0.45)' : 'rgba(120,20,80,0.18)';
        for (let r = 0; r < rows; r++) {
          const yOff = 8 + r * 9;
          for (let face = 0; face < 2; face++) {
            const P = face === 0 ? D : C, Q = face === 0 ? C : B;
            for (let w = 0; w < 2; w++) {
              const t0 = w === 0 ? 0.18 : 0.58, t1 = t0 + 0.24;
              const on = hash(id, r * 4 + w, face) < (night ? 0.55 : 0.8);
              ctx.strokeStyle = on ? lit : dim;
              ctx.beginPath();
              ctx.moveTo(P[0] + (Q[0] - P[0]) * t0, P[1] + (Q[1] - P[1]) * t0 - yOff);
              ctx.lineTo(P[0] + (Q[0] - P[0]) * t1, P[1] + (Q[1] - P[1]) * t1 - yOff);
              ctx.stroke();
            }
          }
        }
      }

      // neon roof outline
      if (night) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.4 / Math.max(z, 0.5);
        ctx.beginPath();
        ctx.moveTo(A[0], A[1] - h); ctx.lineTo(B[0], B[1] - h); ctx.lineTo(C[0], C[1] - h); ctx.lineTo(D[0], D[1] - h); ctx.closePath();
        ctx.stroke();
      }
      // edge highlight
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1 / Math.max(z, 0.5);
      ctx.beginPath();
      ctx.moveTo(D[0], D[1] - h); ctx.lineTo(C[0], C[1] - h); ctx.lineTo(B[0], B[1] - h);
      ctx.moveTo(C[0], C[1] - h); ctx.lineTo(C[0], C[1]);
      ctx.stroke();

      // antenna with blinking light on skyscrapers
      if (h > 110) {
        const [cx, cy] = iso(l.gx + 0.5, l.gy + 0.5);
        ctx.strokeStyle = rgb(shade(base, 0.5));
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx, cy - h); ctx.lineTo(cx, cy - h - 16); ctx.stroke();
        if (Math.sin(this.time * 3 + id) > 0.2) {
          ctx.fillStyle = night ? '#ff4d6d' : '#ff6b6b';
          ctx.beginPath(); ctx.arc(cx, cy - h - 17, 2.2, 0, Math.PI * 2); ctx.fill();
        }
      }

      // construction glow ring when freshly built
      if (fl > 0.5) {
        ctx.strokeStyle = `rgba(255,255,255,${(fl - 0.5) * 1.6})`;
        ctx.lineWidth = 2 / Math.max(z, 0.4);
        const g = 0.12 - (1 - fl) * 0.5;
        this.diamond(ctx, l.gx + g, l.gy + g, l.gx + 1 - g, l.gy + 1 - g);
        ctx.stroke();
      }
    }

    drawPerson(ctx, p, z) {
      const bob = p.moving ? Math.abs(Math.sin(p.phase)) * 2 : 0;
      const s = Math.max(1, 0.9 / Math.max(z, 0.35)); // keep people visible when zoomed out
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 5 * s, 2.4 * s, 0, 0, Math.PI * 2); ctx.fill();
      // legs
      ctx.strokeStyle = rgb(shade(p.color, 0.5));
      ctx.lineWidth = 1.6 * s;
      const sw = p.moving ? Math.sin(p.phase) * 2.5 * s : 0;
      ctx.beginPath();
      ctx.moveTo(p.x - 1.2 * s, p.y - 5 * s - bob); ctx.lineTo(p.x - 1.2 * s + sw, p.y);
      ctx.moveTo(p.x + 1.2 * s, p.y - 5 * s - bob); ctx.lineTo(p.x + 1.2 * s - sw, p.y);
      ctx.stroke();
      // body
      ctx.fillStyle = p.colorStr;
      this.roundRect(ctx, p.x - 3 * s, p.y - 12 * s - bob, 6 * s, 8 * s, 2.5 * s);
      ctx.fill();
      // head
      ctx.fillStyle = '#ffe1c4';
      ctx.beginPath(); ctx.arc(p.x, p.y - 15 * s - bob, 2.8 * s, 0, Math.PI * 2); ctx.fill();
      // name tag when recently active
      const recent = this.time - p.lastSeen < 3.5;
      if (recent && z > 0.18) {
        const fs = Math.max(8, 10 / Math.max(z, 0.5));
        ctx.font = `600 ${fs}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = p.name.length > 18 ? p.name.slice(0, 17) + '…' : p.name;
        const w = ctx.measureText(label).width + fs;
        const y = p.y - 26 * s - bob;
        const a = Math.min(1, (3.5 - (this.time - p.lastSeen)) * 1.5);
        ctx.globalAlpha = p.alpha * a;
        ctx.fillStyle = this.sky === 'night' ? 'rgba(34,24,72,0.88)' : 'rgba(255,255,255,0.95)';
        this.roundRect(ctx, p.x - w / 2, y - fs * 0.8, w, fs * 1.6, fs * 0.8);
        ctx.fill();
        ctx.fillStyle = p.colorStr;
        ctx.fillText(label, p.x, y + 0.5);
      }
      ctx.globalAlpha = 1;
    }

    /* ---------------- celebration cards ---------------- */
    showCard(card) {
      card.t = 0;
      card.started = false;
      this.cards.push(card);
    }
    clearCards() {
      this.cards = [];
      this.confetti = [];
    }
    burstConfetti(n) {
      const cols = ['#ff2e93', '#ff85c2', '#c86bff', '#ffd23f', '#ffffff', '#7fd0ff', '#ffb3d9'];
      for (let i = 0; i < n; i++) {
        this.confetti.push({
          x: this.w / 2 + (Math.random() - 0.5) * this.w * 0.5, y: this.h * 0.42 + (Math.random() - 0.5) * 60,
          vx: (Math.random() - 0.5) * 700, vy: -250 - Math.random() * 450,
          rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 12,
          w: 5 + Math.random() * 6, h: 8 + Math.random() * 8,
          c: cols[i % cols.length], life: 0, max: 2.4 + Math.random() * 1.2, star: Math.random() < 0.3,
        });
      }
    }
    updateCards(dt) {
      if (this.cards.length) {
        const c = this.cards[0];
        if (!c.started) { c.started = true; this.burstConfetti(c.type === 'year' ? 140 : 90); }
        c.t += dt;
        if (c.t >= c.dur) this.cards.shift();
      }
      let w = 0;
      for (const p of this.confetti) {
        p.life += dt;
        if (p.life >= p.max) continue;
        p.vy += 700 * dt;
        p.vx *= 1 - dt * 1.5;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        this.confetti[w++] = p;
      }
      this.confetti.length = w;
    }
    drawConfetti(ctx) {
      for (const p of this.confetti) {
        const a = Math.min(1, (p.max - p.life) * 2);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        if (p.star) {
          const c = hexToRgb(p.c);
          this.sparkle(ctx, 0, 0, p.h * 0.8, a, `${c[0]},${c[1]},${c[2]}`);
        } else {
          ctx.fillStyle = p.c;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 1.7)) + 1);
        }
        ctx.restore();
      }
    }
    drawCard(ctx, c) {
      const W = this.w, H = this.h;
      const t = c.t;
      const easeOutBack = (x) => { const k = 1.70158; return 1 + (k + 1) * Math.pow(x - 1, 3) + k * Math.pow(x - 1, 2); };
      const appear = easeOutBack(Math.min(1, t / 0.5));
      const fade = Math.max(0, Math.min(1, t / 0.2, (c.dur - t) / 0.45));
      ctx.save();
      if (c.type === 'birthday') {
        const s = Math.max(0.8, Math.min(1.3, W / 1100));
        ctx.font = `800 ${20 * s}px Inter, sans-serif`;
        const tw = Math.max(ctx.measureText('🎂 ' + c.label + ' 🎉').width, 200) + 60 * s;
        const ph = 74 * s;
        const y = H * 0.2;
        ctx.globalAlpha = fade;
        ctx.translate(W / 2, y);
        ctx.scale(appear, appear);
        ctx.shadowColor = 'rgba(255,46,147,0.35)';
        ctx.shadowBlur = 30;
        ctx.fillStyle = '#ffffff';
        this.roundRect(ctx, -tw / 2, -ph / 2, tw, ph, ph / 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 3;
        const gb = ctx.createLinearGradient(-tw / 2, 0, tw / 2, 0);
        gb.addColorStop(0, '#ff2e93'); gb.addColorStop(1, '#c86bff');
        ctx.strokeStyle = gb;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ff2e93';
        ctx.fillText('🎂 ' + c.label + ' 🎉', 0, -10 * s);
        ctx.font = `600 ${12 * s}px Inter, sans-serif`;
        ctx.fillStyle = '#a35f86';
        ctx.fillText(c.sub, 0, 16 * s);
        ctx.restore();
        return;
      }

      // ---- Year in Review card ----
      ctx.fillStyle = `rgba(255,240,248,${0.45 * fade})`;
      ctx.fillRect(0, 0, W, H);
      const s = Math.max(0.62, Math.min(1.15, Math.min(W / 640, H / 560)));
      const cw = 440 * s, ch = 430 * s;
      ctx.globalAlpha = fade;
      ctx.translate(W / 2, H / 2);
      ctx.scale(appear, appear);
      ctx.rotate(Math.sin(t * 1.4) * 0.006);
      ctx.shadowColor = 'rgba(255,46,147,0.45)';
      ctx.shadowBlur = 50;
      const g = ctx.createLinearGradient(-cw / 2, -ch / 2, cw / 2, ch / 2);
      g.addColorStop(0, '#ff7cc0');
      g.addColorStop(0.5, '#ff2e93');
      g.addColorStop(1, '#c86bff');
      ctx.fillStyle = g;
      this.roundRect(ctx, -cw / 2, -ch / 2, cw, ch, 28 * s);
      ctx.fill();
      ctx.shadowBlur = 0;
      // glossy highlight
      const gl = ctx.createLinearGradient(0, -ch / 2, 0, 0);
      gl.addColorStop(0, 'rgba(255,255,255,0.28)');
      gl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gl;
      this.roundRect(ctx, -cw / 2 + 6 * s, -ch / 2 + 6 * s, cw - 12 * s, ch / 2, 24 * s);
      ctx.fill();
      // twinkles on the card
      for (let k = 0; k < 7; k++) {
        const sx = (hash(k, c.year, 3) - 0.5) * cw * 0.9, sy = (hash(k, c.year, 4) - 0.5) * ch * 0.9;
        this.sparkle(ctx, sx, sy, (4 + 5 * hash(k, 1, 5)) * s * (0.6 + 0.4 * Math.sin(t * 4 + k)), 0.8, '255,255,255');
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      let y = -ch / 2 + 44 * s;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `800 ${12 * s}px Inter, sans-serif`;
      ctx.fillText(c.partial ? '✨  YEAR IN REVIEW · SO FAR  ✨' : '✨  YEAR IN REVIEW  ✨', 0, y);
      y += 66 * s;
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 ${68 * s}px Inter, sans-serif`;
      ctx.fillText(String(c.year), 0, y);
      y += 26 * s;
      ctx.font = `600 ${13 * s}px "JetBrains Mono", monospace`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(c.repo, 0, y);

      // 4 stat tiles
      const tiles = [['commits', c.commits], ['new buildings', c.added], ['citizens', c.people], ['fires put out', c.bugs]];
      const tw = (cw - 60 * s) / 4, th = 62 * s;
      y += 18 * s;
      tiles.forEach(([k, v], idx) => {
        const x = -cw / 2 + 24 * s + idx * (tw + 4 * s);
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        this.roundRect(ctx, x, y, tw, th, 14 * s);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `800 ${22 * s}px "JetBrains Mono", monospace`;
        // count up while the card opens
        const shown = Math.round(v * Math.min(1, t / 1.1));
        ctx.fillText(shown.toLocaleString(), x + tw / 2, y + 32 * s);
        ctx.font = `600 ${10 * s}px Inter, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(k, x + tw / 2, y + 50 * s);
      });
      y += th + 18 * s;

      // month bars
      const bw = (cw - 60 * s) / 12, bh = 58 * s;
      const max = Math.max(1, ...c.months);
      const grow = Math.min(1, Math.max(0, (t - 0.3) / 0.9));
      c.months.forEach((n, k) => {
        const x = -cw / 2 + 30 * s + k * bw;
        const h = Math.max(2, (n / max) * bh * grow);
        const isBusy = n === max && n > 0;
        ctx.fillStyle = isBusy ? '#ffffff' : 'rgba(255,255,255,0.45)';
        this.roundRect(ctx, x + 2 * s, y + bh - h, bw - 4 * s, h, Math.min(5 * s, h / 2));
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `700 ${9 * s}px Inter, sans-serif`;
        ctx.fillText('JFMAMJJASOND'[k], x + bw / 2, y + bh + 13 * s);
      });
      y += bh + 38 * s;
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${14 * s}px Inter, sans-serif`;
      ctx.fillText(`💖 Top citizen: ${c.top} (${c.topN} commits)`, 0, y);
      y += 22 * s;
      ctx.font = `600 ${13 * s}px Inter, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText(`📅 Busiest month: ${c.busiest} · ${c.busiestN} commits`, 0, y);
      y += 20 * s;
      ctx.fillText(`🏙️ Fastest-growing district: ${c.district}`, 0, y);
      ctx.restore();
    }

    roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /** In-canvas overlay used in cinema mode and while recording, so videos carry the stats. */
    drawHud(ctx) {
      const info = this.hudInfo;
      const W = this.w, H = this.h;
      const pad = Math.max(16, W * 0.025);
      const scale = Math.max(0.75, Math.min(1.4, W / 1280));
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';

      const day = this.sky !== 'night';
      const shadeRGB = day ? '255,255,255' : '26,18,60';
      const g = ctx.createLinearGradient(0, 0, 0, 150 * scale);
      g.addColorStop(0, `rgba(${shadeRGB},${day ? 0.85 : 0.7})`);
      g.addColorStop(1, `rgba(${shadeRGB},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, 150 * scale);

      ctx.fillStyle = day ? '#ff2e93' : 'rgba(255,214,240,0.95)';
      ctx.font = `600 ${14 * scale}px "JetBrains Mono", monospace`;
      ctx.fillText(info.repo, pad, pad + 12 * scale);
      ctx.fillStyle = day ? '#4a1438' : '#ffffff';
      ctx.font = `800 ${34 * scale}px Inter, sans-serif`;
      ctx.fillText(info.date, pad, pad + 50 * scale);

      const stats = [
        ['COMMITS', info.commits, day ? '#ff2e93' : '#ffb3da'],
        ['BUILDINGS', info.files, day ? '#c247e8' : '#a6d8ff'],
        ['CITIZENS', info.people, day ? '#1fb886' : '#9ef0d0'],
        ['FIRES PUT OUT', info.bugs, day ? '#ff8a00' : '#fff2a1'],
      ];
      let x = W - pad;
      ctx.textAlign = 'right';
      for (let i = stats.length - 1; i >= 0; i--) {
        const [k, v, c] = stats[i];
        ctx.font = `700 ${26 * scale}px "JetBrains Mono", monospace`;
        const vw = ctx.measureText(String(v)).width;
        ctx.font = `600 ${10 * scale}px Inter, sans-serif`;
        const kw = ctx.measureText(k).width;
        const colW = Math.max(vw, kw);
        ctx.fillStyle = c;
        ctx.font = `700 ${26 * scale}px "JetBrains Mono", monospace`;
        ctx.fillText(String(v), x, pad + 40 * scale);
        ctx.fillStyle = day ? 'rgba(163,95,134,0.9)' : 'rgba(200,210,255,0.7)';
        ctx.font = `600 ${10 * scale}px Inter, sans-serif`;
        ctx.fillText(k, x, pad + 12 * scale);
        x -= colW + 28 * scale;
      }

      // bottom ticker
      const bg = ctx.createLinearGradient(0, H - 90 * scale, 0, H);
      bg.addColorStop(0, `rgba(${shadeRGB},0)`);
      bg.addColorStop(1, `rgba(${shadeRGB},${day ? 0.9 : 0.75})`);
      ctx.fillStyle = bg;
      ctx.fillRect(0, H - 90 * scale, W, 90 * scale);
      if (info.lastMsg) {
        ctx.textAlign = 'left';
        ctx.font = `700 ${14 * scale}px Inter, sans-serif`;
        ctx.fillStyle = info.lastColor || '#fff';
        const who = info.lastAuthor + '  ';
        ctx.fillText(who, pad, H - pad - 4 * scale);
        const ww = ctx.measureText(who).width;
        ctx.font = `500 ${14 * scale}px Inter, sans-serif`;
        ctx.fillStyle = info.lastBug ? (day ? '#ff6a00' : '#ffb27a') : (day ? '#6b2a55' : 'rgba(230,235,255,0.9)');
        let msg = (info.lastBug ? '🔥 ' : '') + info.lastMsg;
        const maxW = W * 0.62 - ww;
        while (ctx.measureText(msg).width > maxW && msg.length > 4) msg = msg.slice(0, -2);
        if (msg !== (info.lastBug ? '🔥 ' : '') + info.lastMsg) msg += '…';
        ctx.fillText(msg, pad + ww, H - pad - 4 * scale);
      }
      ctx.textAlign = 'right';
      ctx.font = `700 ${13 * scale}px Inter, sans-serif`;
      ctx.fillStyle = day ? '#ff2e93' : 'rgba(255,255,255,0.85)';
      ctx.fillText('✨ Codebase Time Machine', W - pad, H - pad - 4 * scale);

      // progress line
      ctx.fillStyle = day ? 'rgba(255,46,147,0.15)' : 'rgba(255,255,255,0.12)';
      ctx.fillRect(0, H - 4, W, 4);
      const pg = ctx.createLinearGradient(0, 0, W, 0);
      pg.addColorStop(0, '#ff2e93');
      pg.addColorStop(0.5, '#ff85c2');
      pg.addColorStop(1, '#c86bff');
      ctx.fillStyle = pg;
      ctx.fillRect(0, H - 4, W * info.progress, 4);
    }
  }

  CTM.City = City;
})();
