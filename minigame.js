/* Two-Minute Drill: the Woodson Clan easter egg.
 * An endless runner: you're the ball carrier, defenders come at you, and
 * every 100 yards is a touchdown (and the defense speeds up).
 *   Jump:  tap, Space, ↑ or W     (hurdle a lineman)
 *   Slide: swipe down, ↓ or S     (duck a diving safety)
 * Loaded on demand by app.js (openMiniGame) and exposes window.wccMiniGame.
 * Pixel-art sprites live in assets/minigame/ (horizontal strips of equal
 * frames). Until a sprite has loaded, or if it fails, that piece falls back
 * to the original canvas shapes. Hitboxes don't depend on the art. */
(() => {
  const BEST_KEY = 'wcc-mg-best';
  const readBest = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } };
  const saveBest = (v) => { try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* blocked */ } };

  let root, canvas, ctx, raf = 0, last = 0, W = 0, H = 0, dpr = 1;
  let game = null;
  let swipeY = null;

  const rr = (x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
  // name: frame count. Strips are cut into equal-width frames.
  const SHEETS = { run: 6, jump: 2, hurt: 1, slide: 2, lineman: 4, diver: 2, football: 4, turf: 1, stadium: 1 };
  const art = {};
  function loadArt() {
    Object.keys(SHEETS).forEach((name) => {
      if (art[name]) return;
      const img = new Image();
      img.decoding = 'async';
      img.src = `assets/minigame/${name}.${name === 'stadium' ? 'jpg' : 'png'}`;
      art[name] = img;
    });
  }
  const ready = (name) => art[name]?.complete && art[name].naturalWidth > 0;
  // Draws frame i of a strip into the box (x, y, w, h). Returns false when
  // the art isn't loaded, so the caller can draw its fallback shape.
  function sprite(name, i, x, y, w, h, flip = false) {
    if (!ready(name)) return false;
    const img = art[name];
    const n = SHEETS[name];
    const fw = img.naturalWidth / n;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (flip) {
      ctx.save();
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, (i % n) * fw, 0, fw, img.naturalHeight, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(img, (i % n) * fw, 0, fw, img.naturalHeight, x, y, w, h);
    }
    return true;
  }
  // Height-based size for a sprite, keeping its frame's aspect ratio.
  const widthFor = (name, h) => (ready(name) ? h * (art[name].naturalWidth / SHEETS[name]) / art[name].naturalHeight : h);

  const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  function newGame() {
    return {
      state: 'ready', // ready | run | over
      t: 0,
      speed: 260,     // px/s at the start
      yards: 0,
      best: readBest(),
      tds: 0,
      flash: 0,
      player: { y: 0, vy: 0, slide: 0, onGround: true, kind: 0 },
      dist: 0,
      obs: [],
      bonus: [],
      nextObs: 1.1,
      nextBonus: 3,
      scroll: 0,
      shake: 0,
    };
  }

  // Ground line and player size scale with the screen.
  const ground = () => H * 0.72;
  const unit = () => Math.max(14, Math.min(W / 16, H / 28));

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = root.clientWidth;
    H = root.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function jump() {
    if (!game) return;
    if (game.state === 'over' && performance.now() - game.overAt < 700) return; // no accidental instant restart
    if (game.state !== 'run') { start(); return; }
    const p = game.player;
    if (p.onGround) { p.vy = -unit() * 34; p.onGround = false; p.slide = 0; }
  }
  function slide() {
    if (!game || game.state !== 'run') return;
    const p = game.player;
    if (p.onGround) { if (p.slide <= 0) p.kind ^= 1; p.slide = 0.55; }
    else p.vy = Math.max(p.vy, unit() * 30); // fast drop
  }
  function start() {
    const best = game?.best ?? readBest();
    game = newGame();
    game.best = best;
    game.state = 'run';
  }

  function spawnObstacle() {
    const u = unit();
    const flyer = game.yards > 25 && Math.random() < 0.35;
    if (flyer) {
      // A diving safety at head height: slide under.
      game.obs.push({ kind: 'dive', x: W + u * 2, w: u * 3.4, h: u * 1.1, y: ground() - u * 3.1 });
    } else {
      // A lineman (or two, later on): jump over.
      const pair = game.yards > 60 && Math.random() < 0.25;
      const w = u * (pair ? 3.6 : 1.8);
      game.obs.push({ kind: 'line', x: W + u * 2, w, h: u * 2.6, y: ground() - u * 2.6, pair });
    }
    const gap = Math.max(0.55, 1.35 - game.yards / 400) + Math.random() * 0.8;
    game.nextObs = gap;
  }

  function update(dt) {
    const g = game;
    const u = unit();
    if (g.flash > 0) g.flash -= dt;
    if (g.shake > 0) g.shake -= dt;
    if (g.state !== 'run') return;
    g.t += dt;
    g.speed = 260 + Math.min(420, g.tds * 45 + g.t * 4);
    const dx = g.speed * dt;
    g.scroll = (g.scroll + dx) % (u * 6);
    g.dist += dx;
    g.yards += dx / (u * 2.2);
    const td = Math.floor(g.yards / 100);
    if (td > g.tds) { g.tds = td; g.flash = 1.4; }

    // Player physics.
    const p = g.player;
    if (!p.onGround) {
      p.vy += u * 95 * dt;
      p.y += p.vy * dt;
      if (p.y >= 0) { p.y = 0; p.vy = 0; p.onGround = true; }
    }
    if (p.slide > 0) p.slide -= dt;

    // Spawns.
    g.nextObs -= dt;
    if (g.nextObs <= 0) spawnObstacle();
    g.nextBonus -= dt;
    if (g.nextBonus <= 0) {
      g.bonus.push({ x: W + u, y: ground() - u * (2 + Math.random() * 3.5), r: u * 0.55 });
      g.nextBonus = 2.5 + Math.random() * 3;
    }
    g.obs.forEach((o) => { o.x -= dx * (o.kind === 'dive' ? 1.25 : 1); });
    g.bonus.forEach((b) => { b.x -= dx; });
    g.obs = g.obs.filter((o) => o.x + o.w > -u * 2);
    g.bonus = g.bonus.filter((b) => b.x > -u * 2 && !b.got);

    // Collisions, with a little forgiveness.
    const box = playerBox();
    const pad = u * 0.25;
    for (const o of g.obs) {
      if (box.x + box.w - pad > o.x && box.x + pad < o.x + o.w && box.y + box.h - pad > o.y && box.y + pad < o.y + o.h) {
        g.state = 'over';
        g.overAt = performance.now();
        g.shake = 0.35;
        if (Math.floor(g.yards) > g.best) { g.best = Math.floor(g.yards); g.newBest = true; saveBest(g.best); }
        navigator.vibrate?.(60);
        return;
      }
    }
    for (const b of g.bonus) {
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      if (Math.hypot(cx - b.x, cy - b.y) < b.r + box.w * 0.6) { b.got = true; g.yards += 5; g.flash = Math.max(g.flash, 0.01); g.pop = { x: b.x, y: b.y, t: 0.7 }; }
    }
    if (g.pop) { g.pop.t -= dt; g.pop.y -= u * dt * 3; if (g.pop.t <= 0) g.pop = null; }
  }

  function playerBox() {
    const u = unit();
    const p = game.player;
    const sliding = p.slide > 0 && p.onGround;
    const w = sliding ? u * 2.6 : u * 1.5;
    const h = sliding ? u * 1.2 : u * 3;
    return { x: W * 0.18, y: ground() - h + p.y, w, h, sliding };
  }

  function draw() {
    const g = game;
    const u = unit();
    const green = css('--green', '#a8ff3d');
    const text = css('--text', '#e8f5ee');
    const mute = css('--text-mute', '#8aa399');
    ctx.save();
    if (g.shake > 0) ctx.translate((Math.random() - 0.5) * u * 0.6, (Math.random() - 0.5) * u * 0.6);

    // Field: the stadium backdrop (slow parallax) over pixel turf, or the
    // drawn night field until the art loads.
    if (ready('stadium') && ready('turf')) drawField();
    else drawPlainField();

    // Bonus: a spinning football (+5 yards).
    g.bonus.forEach((b) => {
      const s = b.r * 2.8;
      if (!sprite('football', Math.floor(g.t * 10), b.x - s / 2, b.y - s / 2, s, s)) drawBall(b.x, b.y, b.r, g.t * 4);
    });
    if (g.pop) {
      ctx.fillStyle = green;
      ctx.font = `900 ${u * 0.9}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('+5', g.pop.x, g.pop.y);
    }

    // Defenders.
    g.obs.forEach((o) => (o.kind === 'dive' ? drawDiver(o) : drawLineman(o)));

    // Ball carrier.
    drawRunner();

    ctx.restore();

    // HUD (shadowed so it reads over the stadium).
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 6;
    ctx.textAlign = 'left';
    ctx.fillStyle = text;
    ctx.font = `900 ${u * 1.2}px system-ui, sans-serif`;
    ctx.fillText(`${Math.floor(g.yards)} YDS`, u, u * 2);
    ctx.fillStyle = mute;
    ctx.font = `700 ${u * 0.7}px system-ui, sans-serif`;
    ctx.fillText(`BEST ${g.best}  ·  TD ${g.tds}`, u, u * 3);

    if (g.flash > 0.02 && g.tds > 0) {
      ctx.globalAlpha = Math.min(1, g.flash);
      ctx.textAlign = 'center';
      ctx.fillStyle = green;
      ctx.font = `900 ${u * 2.2}px system-ui, sans-serif`;
      ctx.fillText('TOUCHDOWN!', W / 2, H * 0.32, W - 32);
      ctx.globalAlpha = 1;
    }

    ctx.shadowBlur = 0;
    if (g.state !== 'run') {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.fillStyle = text;
      ctx.font = `900 ${u * 1.8}px system-ui, sans-serif`;
      const over = g.state === 'over';
      ctx.fillText(over ? `TACKLED at ${Math.floor(g.yards)} yds` : 'TWO-MINUTE DRILL', W / 2, H * 0.36, W - 32);
      ctx.font = `700 ${u * 0.85}px system-ui, sans-serif`;
      ctx.fillStyle = over && g.newBest ? green : mute;
      ctx.fillText(over ? (g.newBest ? 'New personal best! 🏆' : `Best: ${g.best} yds`) : 'Hurdle linemen · slide under divers · grab footballs', W / 2, H * 0.36 + u * 1.6, W - 32);
      ctx.fillStyle = green;
      ctx.font = `900 ${u * 1}px system-ui, sans-serif`;
      ctx.fillText(over ? 'Tap to run it back' : 'Tap to hike', W / 2, H * 0.36 + u * 3.2);
    }
  }

  function drawPlainField() {
    const u = unit();
    const g = game;
    const sky = ctx.createLinearGradient(0, 0, 0, ground());
    sky.addColorStop(0, '#04110b');
    sky.addColorStop(1, '#0c2a1b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, ground());
    // Stadium lights.
    ctx.fillStyle = 'rgba(255,255,230,0.08)';
    [0.15, 0.5, 0.85].forEach((f) => { ctx.beginPath(); ctx.arc(W * f, u * 1.5, u * 4, 0, Math.PI * 2); ctx.fill(); });
    ctx.fillStyle = '#16492d';
    ctx.fillRect(0, ground(), W, H - ground());
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    for (let x = -g.scroll; x < W + u * 6; x += u * 6) {
      ctx.beginPath(); ctx.moveTo(x, ground()); ctx.lineTo(x - u * 2, H); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(0, ground(), W, 2);
  }

  function drawField() {
    const g = game;
    const gy = ground();
    ctx.imageSmoothingEnabled = false;
    // Stadium: its bottom edge sits on the ground line, tiled sideways.
    const st = art.stadium;
    const sh = gy * 1.02, sw = sh * st.naturalWidth / st.naturalHeight;
    ctx.fillStyle = '#071510';
    ctx.fillRect(0, 0, W, gy);
    let sx = -((g.dist * 0.12) % sw);
    for (; sx < W; sx += sw) ctx.drawImage(st, sx, gy - sh, sw, sh);
    // Turf: grass tips poke just above the ground line; scrolls at full speed.
    const tf = art.turf;
    const th = Math.max(H - gy, 60) * 1.06, tw = th * tf.naturalWidth / tf.naturalHeight;
    const top = gy - th * 0.05;
    let tx = -(g.dist % tw);
    for (; tx < W; tx += tw) ctx.drawImage(tf, Math.floor(tx), top, Math.ceil(tw) + 1, th);
  }

  function drawBall(x, y, r, spin) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(spin);
    ctx.fillStyle = '#8b4a1f';
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.3, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath(); ctx.moveTo(-r * 0.5, 0); ctx.lineTo(r * 0.5, 0); ctx.stroke();
    for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(i * r * 0.2, -r * 0.18); ctx.lineTo(i * r * 0.2, r * 0.18); ctx.stroke(); }
    ctx.restore();
  }

  function drawRunner() {
    const u = unit();
    const b = playerBox();
    const p = game.player;
    const foot = b.y + b.h; // sprites stand on the box's bottom edge
    if (game.state === 'over' && ready('hurt')) {
      const h = u * 4.4, w = widthFor('hurt', h);
      if (sprite('hurt', 0, b.x + b.w / 2 - w * 0.35, foot - h, w, h)) return;
    }
    if (b.sliding && ready('slide')) {
      const h = u * 1.75, w = widthFor('slide', h);
      if (sprite('slide', p.kind, b.x + b.w / 2 - w / 2, foot - h + u * 0.1, w, h)) return;
    }
    if (!b.sliding) {
      const name = p.onGround ? 'run' : 'jump';
      if (ready(name)) {
        const h = u * 3.5, w = widthFor(name, h);
        const i = p.onGround ? Math.floor(game.dist / (u * 1.1)) : (p.vy < 0 ? 0 : 1);
        if (sprite(name, i, b.x + b.w / 2 - w / 2, foot - h + u * 0.1, w, h)) return;
      }
    }
    const green = css('--green', '#a8ff3d');
    const legPhase = Math.sin(game.t * 18);
    ctx.save();
    if (b.sliding) {
      // Feet-first slide.
      ctx.fillStyle = green;
      ctx.fillRect(b.x, b.y + b.h * 0.25, b.w * 0.7, b.h * 0.55);
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(b.x + b.w * 0.6, b.y + b.h * 0.45, b.w * 0.4, b.h * 0.3);
      ctx.fillStyle = '#d9d9d9';
      ctx.beginPath(); ctx.arc(b.x + u * 0.35, b.y + u * 0.35, u * 0.5, 0, Math.PI * 2); ctx.fill();
    } else {
      // Legs.
      ctx.strokeStyle = '#e8e8e8';
      ctx.lineWidth = u * 0.35;
      ctx.lineCap = 'round';
      const hipY = b.y + b.h * 0.62;
      const run = game.player.onGround ? legPhase : 0.6;
      ctx.beginPath(); ctx.moveTo(b.x + b.w * 0.5, hipY); ctx.lineTo(b.x + b.w * (0.5 + run * 0.4), b.y + b.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(b.x + b.w * 0.5, hipY); ctx.lineTo(b.x + b.w * (0.5 - run * 0.4), b.y + b.h); ctx.stroke();
      // Jersey.
      ctx.fillStyle = green;
      rr(b.x, b.y + b.h * 0.24, b.w, b.h * 0.42, u * 0.25);
      ctx.fill();
      ctx.fillStyle = '#0a1410';
      ctx.font = `900 ${u * 0.7}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('1', b.x + b.w / 2, b.y + b.h * 0.52);
      // Helmet with a facemask.
      ctx.fillStyle = '#d9d9d9';
      ctx.beginPath(); ctx.arc(b.x + b.w * 0.55, b.y + b.h * 0.14, u * 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(b.x + b.w * 0.85, b.y + b.h * 0.06); ctx.lineTo(b.x + b.w * 1.05, b.y + b.h * 0.2); ctx.stroke();
      // Ball tucked under the arm.
      drawBall(b.x + b.w * 0.95, b.y + b.h * 0.42, u * 0.32, -0.5);
    }
    ctx.restore();
  }

  function drawLineman(o) {
    const u = unit();
    if (ready('lineman')) {
      const count = o.pair ? 2 : 1, each = o.w / count;
      const h = o.h * 1.18, w = widthFor('lineman', h);
      // Back one first so the front one overlaps it.
      for (let i = count - 1; i >= 0; i--) {
        const cx = o.x + each * (i + 0.5);
        sprite('lineman', Math.floor(game.t * 9) + i * 2, cx - w / 2, o.y + o.h - h, w, h);
      }
      return;
    }
    const red = css('--red', '#ff4d6d');
    const count = o.pair ? 2 : 1;
    const each = o.w / count;
    for (let i = 0; i < count; i++) {
      const x = o.x + i * each;
      ctx.fillStyle = red;
      rr(x + each * 0.05, o.y + o.h * 0.25, each * 0.9, o.h * 0.5, u * 0.3);
      ctx.fill();
      ctx.fillStyle = '#f4f4f4';
      ctx.fillRect(x + each * 0.2, o.y + o.h * 0.72, each * 0.22, o.h * 0.28);
      ctx.fillRect(x + each * 0.58, o.y + o.h * 0.72, each * 0.22, o.h * 0.28);
      ctx.fillStyle = '#2b2b2b';
      ctx.beginPath(); ctx.arc(x + each * 0.35, o.y + o.h * 0.15, u * 0.55, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawDiver(o) {
    const u = unit();
    if (ready('diver')) {
      const w = o.w * 1.15, h = w / widthFor('diver', 1);
      sprite('diver', Math.floor(game.t * 6), o.x + o.w / 2 - w / 2, o.y + o.h / 2 - h / 2, w, h);
      return;
    }
    const red = css('--red', '#ff4d6d');
    ctx.save();
    ctx.fillStyle = red;
    rr(o.x + u * 0.8, o.y, o.w - u * 1.4, o.h, u * 0.4);
    ctx.fill();
    ctx.fillStyle = '#2b2b2b';
    ctx.beginPath(); ctx.arc(o.x + u * 0.55, o.y + o.h / 2, u * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f4f4f4';
    ctx.lineWidth = u * 0.3;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(o.x + o.w - u * 0.6, o.y + o.h * 0.3); ctx.lineTo(o.x + o.w, o.y - u * 0.2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(o.x + o.w - u * 0.6, o.y + o.h * 0.7); ctx.lineTo(o.x + o.w + u * 0.2, o.y + o.h + u * 0.1); ctx.stroke();
    ctx.restore();
  }

  function frame(ts) {
    const dt = Math.min(0.05, (ts - (last || ts)) / 1000);
    last = ts;
    update(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }

  function onKey(e) {
    // Capture phase + stop: the game's keys never reach the app underneath.
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { close(); return; }
    if ([' ', 'ArrowUp', 'w', 'W', 'Enter'].includes(e.key)) { e.preventDefault(); if (!e.repeat) jump(); }
    if (['ArrowDown', 's', 'S'].includes(e.key)) { e.preventDefault(); slide(); }
  }
  function onVisibility() {
    if (document.hidden && game?.state === 'run') { cancelAnimationFrame(raf); raf = 0; }
    else if (!document.hidden && root && !raf) { last = 0; raf = requestAnimationFrame(frame); }
  }

  function open() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'mg';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Two-Minute Drill mini-game');
    root.innerHTML = `
      <canvas></canvas>
      <button type="button" class="mg-close" aria-label="Close game">✕</button>
      <div class="mg-pad">
        <button type="button" class="mg-btn" data-act="slide">⤓ Slide</button>
        <button type="button" class="mg-btn" data-act="jump">Jump ⤒</button>
      </div>`;
    const style = document.createElement('style');
    style.textContent = `
      .mg { position: fixed; inset: 0; z-index: 600; background: #04110b; touch-action: none; user-select: none; -webkit-user-select: none; }
      .mg canvas { display: block; }
      .mg-close { position: absolute; top: calc(10px + env(safe-area-inset-top)); right: 12px; width: 38px; height: 38px; border-radius: 50%; border: 1px solid rgba(255,255,255,.3); background: rgba(0,0,0,.4); color: #fff; font-size: 16px; cursor: pointer; }
      .mg-pad { position: absolute; left: 0; right: 0; bottom: calc(16px + env(safe-area-inset-bottom)); display: flex; justify-content: space-between; padding: 0 16px; pointer-events: none; }
      .mg-btn { pointer-events: auto; min-width: 104px; padding: 14px 18px; border-radius: 14px; border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.08); color: #fff; font: 800 15px system-ui, sans-serif; cursor: pointer; }
      @media (hover: hover) and (pointer: fine) { .mg-pad { opacity: .5; } }`;
    root.appendChild(style);
    document.body.appendChild(root);
    canvas = root.querySelector('canvas');
    ctx = canvas.getContext('2d');
    resize();
    game = newGame();
    loadArt();

    root.querySelector('.mg-close').onclick = (e) => { e.stopPropagation(); close(); };
    root.querySelectorAll('.mg-btn').forEach((b) => {
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); (b.dataset.act === 'jump' ? jump : slide)(); });
    });
    canvas.addEventListener('pointerdown', (e) => { swipeY = e.clientY; });
    canvas.addEventListener('pointerup', (e) => {
      if (swipeY != null && e.clientY - swipeY > 30) slide();
      else jump();
      swipeY = null;
    });
    window.addEventListener('resize', resize);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVisibility);
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function close() {
    if (!root) return;
    cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener('resize', resize);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVisibility);
    root.remove();
    root = null;
    game = null;
  }

  window.wccMiniGame = { open, close };
})();
