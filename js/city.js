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

  const SKY = {
    night: { top: '#050816', mid: '#0d1433', bottom: '#1d1b45', ground: [22, 26, 52], road: [14, 17, 36], plotA: 0.16, light: 0.62, tree: [24, 92, 70] },
    day: { top: '#7cc4ff', mid: '#bfe3ff', bottom: '#eaf6ff', ground: [154, 168, 186], road: [120, 132, 150], plotA: 0.28, light: 1.0, tree: [62, 160, 90] },
  };

  class City {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.model = null;
      this.sky = 'night';
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

      for (const id of res.added) this.flash[id] = 1;
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
          if (this.fire[id] <= 0) this.emitSmoke(id, 10);
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
      if (this.sky === 'night') {
        for (const s of this.stars) {
          const a = 0.35 + 0.35 * Math.sin(this.time * 1.5 + s.p);
          ctx.fillStyle = `rgba(220,230,255,${a})`;
          ctx.beginPath();
          ctx.arc(s.x * this.w, s.y * this.h, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
        // soft moon glow
        const mg = ctx.createRadialGradient(this.w * 0.82, this.h * 0.2, 0, this.w * 0.82, this.h * 0.2, 180);
        mg.addColorStop(0, 'rgba(160,140,255,0.18)');
        mg.addColorStop(1, 'rgba(160,140,255,0)');
        ctx.fillStyle = mg;
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
        ctx.fillStyle = rgb(shade(sky.road, 0.7)); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(b[0], b[1]); ctx.lineTo(r[0], r[1]); ctx.lineTo(r[0], r[1] + depth); ctx.lineTo(b[0], b[1] + depth); ctx.closePath();
        ctx.fillStyle = rgb(shade(sky.road, 0.5)); ctx.fill();
      }

      // road markings between blocks
      ctx.strokeStyle = night ? 'rgba(255,214,120,0.10)' : 'rgba(255,255,255,0.35)';
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
        ctx.fillStyle = rgb(mix(sky.ground, col, 0.25), 1);
        ctx.fill();
        const glowA = night ? 0.35 : 0.5;
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
      ctx.globalCompositeOperation = 'lighter';
      for (const b of this.beams) {
        const p = this.people[b.p];
        if (!p || !p.spawned || this.curH[b.id] < 1) continue;
        const [tx, ty] = this.lotTop(b.id);
        const a = Math.max(0, 1 - b.t / 0.9);
        const col = b.bug ? [255, 140, 40] : b.color;
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
          ctx.fillStyle = night ? `rgba(150,150,170,${0.28 * (1 - t)})` : `rgba(90,90,100,${0.3 * (1 - t)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + t * 1.6), 0, Math.PI * 2); ctx.fill();
        } else if (p.kind === 'dust') {
          ctx.fillStyle = `rgba(190,170,140,${0.45 * (1 - t)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + t), 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalCompositeOperation = 'lighter';
      for (const p of this.particles) {
        const t = p.life / p.max;
        if (p.kind === 'flame') {
          const c = t < 0.3 ? [255, 230, 140] : t < 0.6 ? [255, 140, 40] : [220, 50, 20];
          ctx.fillStyle = rgb(c, 0.85 * (1 - t));
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - t * 0.6), 0, Math.PI * 2); ctx.fill();
        } else if (p.kind === 'spark') {
          ctx.fillStyle = `rgba(255,220,120,${1 - t})`;
          ctx.fillRect(p.x, p.y, 2, 2);
        }
      }
      // fire glow
      for (let id = 0; id < this.fire.length; id++) {
        if (this.fire[id] <= 0 || this.curH[id] < 1) continue;
        const [x, y] = this.lotTop(id);
        const r = 46 + Math.sin(this.time * 20 + id) * 4;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,140,40,0.55)');
        g.addColorStop(1, 'rgba(255,80,20,0)');
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
          ctx.fillStyle = night ? 'rgba(8,10,26,0.7)' : 'rgba(255,255,255,0.75)';
          const ph = fs * 1.5;
          this.roundRect(ctx, x - w / 2, y - ph / 2, w, ph, ph / 2);
          ctx.fill();
          ctx.fillStyle = d.color;
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
      vg.addColorStop(1, night ? 'rgba(0,0,10,0.55)' : 'rgba(0,30,60,0.15)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, this.w, this.h);
      if (this.hud && this.hudInfo) this.drawHud(ctx);
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
        top = mix(top, [255, 120, 40], f); left = mix(left, [200, 70, 30], f); right = mix(right, [150, 40, 20], f);
      }
      if (fl > 0) {
        const t = fl * 0.85;
        top = mix(top, [255, 255, 255], t); left = mix(left, [235, 240, 255], t * 0.8); right = mix(right, [210, 220, 255], t * 0.7);
      }

      // shadow
      ctx.fillStyle = night ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,40,0.14)';
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
        const lit = night ? 'rgba(255,214,130,0.9)' : 'rgba(30,50,90,0.35)';
        const dim = night ? 'rgba(40,50,90,0.6)' : 'rgba(255,255,255,0.25)';
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

      // edge highlight
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
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
        ctx.fillStyle = 'rgba(8,10,26,0.82)';
        this.roundRect(ctx, p.x - w / 2, y - fs * 0.8, w, fs * 1.6, fs * 0.8);
        ctx.fill();
        ctx.fillStyle = p.colorStr;
        ctx.fillText(label, p.x, y + 0.5);
      }
      ctx.globalAlpha = 1;
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

      const g = ctx.createLinearGradient(0, 0, 0, 150 * scale);
      g.addColorStop(0, 'rgba(5,8,22,0.75)');
      g.addColorStop(1, 'rgba(5,8,22,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, 150 * scale);

      ctx.fillStyle = 'rgba(200,210,255,0.8)';
      ctx.font = `600 ${14 * scale}px "JetBrains Mono", monospace`;
      ctx.fillText(info.repo, pad, pad + 12 * scale);
      ctx.fillStyle = '#ffffff';
      ctx.font = `800 ${34 * scale}px Inter, sans-serif`;
      ctx.fillText(info.date, pad, pad + 50 * scale);

      const stats = [
        ['COMMITS', info.commits, '#c4b5fd'],
        ['BUILDINGS', info.files, '#7dd3fc'],
        ['CITIZENS', info.people, '#86efac'],
        ['FIRES PUT OUT', info.bugs, '#ffa94d'],
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
        ctx.fillStyle = 'rgba(200,210,255,0.7)';
        ctx.font = `600 ${10 * scale}px Inter, sans-serif`;
        ctx.fillText(k, x, pad + 12 * scale);
        x -= colW + 28 * scale;
      }

      // bottom ticker
      const bg = ctx.createLinearGradient(0, H - 90 * scale, 0, H);
      bg.addColorStop(0, 'rgba(5,8,22,0)');
      bg.addColorStop(1, 'rgba(5,8,22,0.8)');
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
        ctx.fillStyle = info.lastBug ? '#ffb27a' : 'rgba(230,235,255,0.9)';
        let msg = (info.lastBug ? '🔥 ' : '') + info.lastMsg;
        const maxW = W * 0.62 - ww;
        while (ctx.measureText(msg).width > maxW && msg.length > 4) msg = msg.slice(0, -2);
        if (msg !== (info.lastBug ? '🔥 ' : '') + info.lastMsg) msg += '…';
        ctx.fillText(msg, pad + ww, H - pad - 4 * scale);
      }
      ctx.textAlign = 'right';
      ctx.font = `700 ${13 * scale}px Inter, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText('Codebase Time Machine', W - pad, H - pad - 4 * scale);

      // progress line
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(0, H - 3, W, 3);
      const pg = ctx.createLinearGradient(0, 0, W, 0);
      pg.addColorStop(0, '#7c5cff');
      pg.addColorStop(1, '#38bdf8');
      ctx.fillStyle = pg;
      ctx.fillRect(0, H - 3, W * info.progress, 3);
    }
  }

  CTM.City = City;
})();
