import { BlackHole, Particle, JetParticle, GravWave, tracePhoton, spawnDiskParticle, circularOrbitV, orbitalEccentricity } from './physics.js';

class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;

    // Physical setup (scaled for screen size)
    this.bh = new BlackHole(this.width / 2, this.height / 2, {
      mass: 8e5,
      G_sim: 1.0,
      c_sim: 180,
      diskOuter: Math.max(300, this.width * 0.45)
    });

    // Lists
    this.particles = [];
    this.jets = [];
    this.waves = [];
    this.spaceship = null;

    // Simulation settings
    this.timeScale = 1.0;
    this.isPaused = false;
    this.showPhotonSphere = true;
    this.showISCO = true;
    this.showTrails = true;
    this.showLensingRay = false;
    this.spawnType = 'dust'; // 'dust', 'star', 'planet', 'photon'
    this.autoSpawnAccretion = true;

    // Interaction mouse drag / gravitational pull state
    this.mouse = { x: 0, y: 0, isDown: false, action: 'pull' }; // 'pull', 'spawn_dust', 'spawn_star', 'pilot'

    // Spacecraft State
    this.keys = {};

    this.init();
  }

  init() {
    // Populate some initial accretion disk particles
    for (let i = 0; i < 400; i++) {
      this.particles.push(spawnDiskParticle(this.bh));
    }
  }

  setSpawnType(type) {
    this.spawnType = type;
  }

  clearAll() {
    this.particles = [];
    this.jets = [];
    this.waves = [];
    this.spaceship = null;
  }

  triggerSupernova() {
    // Large wave of incoming high-velocity matter/stars from all directions
    const center = { x: this.bh.x, y: this.bh.y };
    this.waves.push(new GravWave(center.x, center.y, { r0: 10, maxR: Math.max(this.width, this.height), speed: 8, color: '#f55', alpha: 0.8 }));
    
    for (let i = 0; i < 200; i++) {
      const angle = Math.random() * 2 * Math.PI;
      const r = Math.max(this.width, this.height) * 0.5 * (1 + Math.random() * 0.5);
      const px = center.x + r * Math.cos(angle);
      const py = center.y + r * Math.sin(angle);
      
      // Velocity directed towards the BH plus a small transverse component for orbits
      const speed = this.bh.c_sim * 0.15;
      const vx = -speed * Math.cos(angle) + (Math.random() - 0.5) * speed * 0.4;
      const vy = -speed * Math.sin(angle) + (Math.random() - 0.5) * speed * 0.4;

      this.particles.push(new Particle(px, py, vx, vy, {
        mass: 5,
        radius: 3 + Math.random() * 4,
        type: 'star',
        color: `hsl(${Math.random() * 60 + 10}, 100%, 70%)`,
        life: 1000,
        maxTrail: 50
      }));
    }
  }

  triggerMerger() {
    // Create secondary lighter BH that falls in rapidly to trigger heavy GW emissions
    const secondBhX = this.bh.x - 300;
    const secondBhY = this.bh.y - 100;
    const vOrbit = circularOrbitV(this.bh, 316) * 0.85; // slightly sub-circular to spiral in

    const angle = Math.atan2(-100, -300) + Math.PI / 2;
    const vx = vOrbit * Math.cos(angle);
    const vy = vOrbit * Math.sin(angle);

    this.spaceship = null; // deactivate spaceship

    // We can simulate the merger partner as a massive planet particle with gravitational radiation trail
    this.particles.push(new Particle(secondBhX, secondBhY, vx, vy, {
      mass: this.bh.mass * 0.15, // 15% of host mass
      radius: 8,
      type: 'planet',
      color: '#a0f',
      life: 2000,
      maxTrail: 150
    }));

    // Generate heavy waves periodically during spiral
    this._mergerWaveTimer = setInterval(() => {
      const companion = this.particles.find(p => p.type === 'planet' && p.mass > 1000);
      if (!companion) {
        clearInterval(this._mergerWaveTimer);
        return;
      }
      const dx = companion.x - this.bh.x;
      const dy = companion.y - this.bh.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < this.bh.Rs * 1.5) {
        // Collided! Huge final Gravitational Wave
        this.waves.push(new GravWave(this.bh.x, this.bh.y, { r0: this.bh.Rs, maxR: 1200, speed: 12, color: '#b0f', alpha: 1.0 }));
        this.bh.grow(companion.mass);
        companion.dead = true;
        clearInterval(this._mergerWaveTimer);
      } else {
        // Quadrupole emission proxy
        this.waves.push(new GravWave(companion.x, companion.y, { r0: 2, maxR: 400, speed: 6, color: '#c0f', alpha: 0.5 }));
      }
    }, 150);
  }

  spawnSpaceship() {
    const rx = this.bh.x;
    const ry = this.bh.y - 200;
    const speed = circularOrbitV(this.bh, 200) * 1.05; // Circular velocity orbit + safety margin
    this.spaceship = {
      x: rx,
      y: ry,
      vx: speed,
      vy: 0,
      heading: 0, // In radians
      mass: 10,
      fuel: 100,
      health: 100,
      trail: [],
      dead: false
    };
  }

  controlSpaceship(dt) {
    if (!this.spaceship || this.spaceship.dead) return;

    // Rotation
    if (this.keys['ArrowLeft'] || this.keys['a'] || this.keys['A']) {
      this.spaceship.heading -= 4 * dt;
    }
    if (this.keys['ArrowRight'] || this.keys['d'] || this.keys['D']) {
      this.spaceship.heading += 4 * dt;
    }

    // Thrust
    let isThrusting = false;
    if ((this.keys['ArrowUp'] || this.keys['w'] || this.keys['W']) && this.spaceship.fuel > 0) {
      const thrust = 150 * dt;
      this.spaceship.vx += thrust * Math.cos(this.spaceship.heading);
      this.spaceship.vy += thrust * Math.sin(this.spaceship.heading);
      this.spaceship.fuel -= 12 * dt;
      isThrusting = true;
    }

    // Gravity calculation on Spaceship
    const { ax, ay, r } = this.bh.gravity(this.spaceship.x, this.spaceship.y);

    // Event horizon destruction check
    if (r <= this.bh.Rs * 1.02) {
      this.spaceship.dead = true;
      this.spaceship.health = 0;
      this.waves.push(new GravWave(this.spaceship.x, this.spaceship.y, { r0: 5, maxR: 150, speed: 4, color: '#f00', alpha: 0.8 }));
      return;
    }

    // Accretion disk burning & Spaghettification damage
    if (r < this.bh.r_isco) {
      this.spaceship.health -= 25 * dt * (this.bh.r_isco / r);
    }
    const ft = this.bh.tidalAcc(r, 10);
    if (ft > 15) {
      this.spaceship.health -= ft * dt * 2;
    }

    if (this.spaceship.health <= 0) {
      this.spaceship.dead = true;
      // Explode ship
      for (let i = 0; i < 40; i++) {
        const speed = Math.random() * 40 + 10;
        const angle = Math.random() * 2 * Math.PI;
        this.particles.push(new Particle(this.spaceship.x, this.spaceship.y, this.spaceship.vx + speed * Math.cos(angle), this.spaceship.vy + speed * Math.sin(angle), {
          mass: 0.1,
          radius: 1 + Math.random()*2,
          type: 'debris',
          color: i % 2 === 0 ? '#ff4500' : '#ffcc00',
          life: 60,
          maxTrail: 10
        }));
      }
      return;
    }

    // Integration
    const td = this.bh.timeDilation(r);
    const dtEff = dt * td;
    this.spaceship.vx += ax * dtEff;
    this.spaceship.vy += ay * dtEff;

    this.spaceship.x += this.spaceship.vx * dtEff;
    this.spaceship.y += this.spaceship.vy * dtEff;

    // Trail
    this.spaceship.trail.push({ x: this.spaceship.x, y: this.spaceship.y, isThrusting });
    if (this.spaceship.trail.length > 100) this.spaceship.trail.shift();
  }

  // Draw simulation onto Canvas
  draw() {
    this.ctx.clearRect(0, 0, this.width, this.height);

    // Save context
    this.ctx.save();

    // 1. Draw Einstein Ring / Gravitational Lensing effect background grid representation
    this._drawLensingGrid();

    // 2. Draw Wave ripples
    for (const wave of this.waves) {
      this.ctx.strokeStyle = wave.color;
      this.ctx.lineWidth = 2 * wave.alpha;
      this.ctx.beginPath();
      this.ctx.arc(wave.x, wave.y, wave.r, 0, 2 * Math.PI);
      this.ctx.stroke();
    }

    // 3. Draw Accretion disk guide regions
    if (this.showISCO) {
      this.ctx.strokeStyle = 'rgba(255, 60, 0, 0.15)';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([4, 4]);
      this.ctx.beginPath();
      this.ctx.arc(this.bh.x, this.bh.y, this.bh.r_isco, 0, 2 * Math.PI);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }

    if (this.showPhotonSphere) {
      this.ctx.strokeStyle = 'rgba(255, 200, 0, 0.25)';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([2, 2]);
      this.ctx.beginPath();
      this.ctx.arc(this.bh.x, this.bh.y, this.bh.r_photon, 0, 2 * Math.PI);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }

    // 4. Draw Trails
    if (this.showTrails) {
      for (const p of this.particles) {
        if (p.trail.length < 2) continue;
        this.ctx.beginPath();
        this.ctx.moveTo(p.trail[0].x, p.trail[0].y);
        for (let i = 1; i < p.trail.length; i++) {
          this.ctx.lineTo(p.trail[i].x, p.trail[i].y);
        }
        this.ctx.strokeStyle = p.color;
        this.ctx.lineWidth = p.spaghettied ? 0.5 : p.radius * 0.5;
        this.ctx.globalAlpha = 0.35;
        this.ctx.stroke();
      }
    }
    this.ctx.globalAlpha = 1.0;

    // 5. Draw Particles (stars, dust, planets)
    for (const p of this.particles) {
      this.ctx.fillStyle = p.color;
      this.ctx.beginPath();
      if (p.spaghettied) {
        // Render as highly elongated ellipse (spaghettified)
        const velAngle = Math.atan2(p.vy, p.vx);
        this.ctx.save();
        this.ctx.translate(p.x, p.y);
        this.ctx.rotate(velAngle);
        this.ctx.scale(5, 0.2); // stretch in motion direction
        this.ctx.arc(0, 0, p.radius, 0, 2 * Math.PI);
        this.ctx.fill();
        this.ctx.restore();
      } else {
        this.ctx.arc(p.x, p.y, p.radius, 0, 2 * Math.PI);
        this.ctx.fill();
      }
    }

    // 6. Draw Jet relativistic outflow
    for (const j of this.jets) {
      const gradient = this.ctx.createRadialGradient(j.x, j.y, 0, j.x, j.y, j.r * 2);
      gradient.addColorStop(0, `rgba(0, 180, 255, ${j.alpha})`);
      gradient.addColorStop(1, 'rgba(0, 0, 50, 0)');
      this.ctx.fillStyle = gradient;
      this.ctx.beginPath();
      this.ctx.arc(j.x, j.y, j.r * 2, 0, 2 * Math.PI);
      this.ctx.fill();
    }

    // 7. Draw Spaceship
    if (this.spaceship && !this.spaceship.dead) {
      // Draw ship trail
      if (this.spaceship.trail.length > 1) {
        this.ctx.beginPath();
        this.ctx.moveTo(this.spaceship.trail[0].x, this.spaceship.trail[0].y);
        for (let i = 1; i < this.spaceship.trail.length; i++) {
          this.ctx.lineTo(this.spaceship.trail[i].x, this.spaceship.trail[i].y);
        }
        this.ctx.strokeStyle = 'rgba(0, 255, 120, 0.4)';
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();
      }

      this.ctx.save();
      this.ctx.translate(this.spaceship.x, this.spaceship.y);
      this.ctx.rotate(this.spaceship.heading);

      // Ship body triangle
      this.ctx.fillStyle = '#0f8';
      this.ctx.strokeStyle = '#fff';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(8, 0);
      this.ctx.lineTo(-6, -5);
      this.ctx.lineTo(-3, 0);
      this.ctx.lineTo(-6, 5);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.stroke();

      // Flame effect when thrusting
      if (this.keys['ArrowUp'] || this.keys['w'] || this.keys['W']) {
        this.ctx.fillStyle = '#f60';
        this.ctx.beginPath();
        this.ctx.moveTo(-4, 0);
        this.ctx.lineTo(-12, -3);
        this.ctx.lineTo(-8, 0);
        this.ctx.lineTo(-12, 3);
        this.ctx.closePath();
        this.ctx.fill();
      }

      this.ctx.restore();
    }

    // 8. Draw Event Horizon (the physical Black Hole)
    // Dynamic glow
    const hGlow = this.ctx.createRadialGradient(
      this.bh.x, this.bh.y, this.bh.Rs * 0.9,
      this.bh.x, this.bh.y, this.bh.Rs * 2.5
    );
    hGlow.addColorStop(0, 'rgba(0,0,0,1.0)');
    hGlow.addColorStop(0.3, 'rgba(10, 2, 25, 0.9)');
    hGlow.addColorStop(0.4, 'rgba(255, 40, 0, 0.8)'); // Hot inner edge accretion
    hGlow.addColorStop(0.6, 'rgba(255, 120, 0, 0.2)');
    hGlow.addColorStop(1.0, 'rgba(0,0,0,0)');

    this.ctx.fillStyle = hGlow;
    this.ctx.beginPath();
    this.ctx.arc(this.bh.x, this.bh.y, this.bh.Rs * 3.0, 0, 2 * Math.PI);
    this.ctx.fill();

    // Solid black center
    this.ctx.fillStyle = '#000';
    this.ctx.beginPath();
    this.ctx.arc(this.bh.x, this.bh.y, this.bh.Rs, 0, 2 * Math.PI);
    this.ctx.fill();

    // 9. Extra Interactive: Ray Traced Lensing Demonstration
    if (this.showLensingRay) {
      this._drawLensingRays();
    }

    this.ctx.restore();
  }

  // Render Gravitational Lensing Grid lines to approximate spacetime curvature
  _drawLensingGrid() {
    const spacing = 40;
    this.ctx.strokeStyle = '#1b1b3a';
    this.ctx.lineWidth = 1;

    // Horizontal grid lines deformed by Einstein Ring approximation
    for (let y = spacing; y < this.height; y += spacing) {
      this.ctx.beginPath();
      for (let x = 0; x <= this.width; x += 15) {
        const dx = x - this.bh.x;
        const dy = y - this.bh.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        
        let targetX = x;
        let targetY = y;

        if (dist > this.bh.Rs) {
          // Einstein ring shift equation:
          // Shift represents grid magnifying outwards around event horizon
          const deflection = (this.bh.Rs * 35) / dist;
          targetX += (dx / dist) * deflection;
          targetY += (dy / dist) * deflection;
        }

        if (x === 0) this.ctx.moveTo(targetX, targetY);
        else this.ctx.lineTo(targetX, targetY);
      }
      this.ctx.stroke();
    }

    // Vertical grid lines
    for (let x = spacing; x < this.width; x += spacing) {
      this.ctx.beginPath();
      for (let y = 0; y <= this.height; y += 15) {
        const dx = x - this.bh.x;
        const dy = y - this.bh.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        
        let targetX = x;
        let targetY = y;

        if (dist > this.bh.Rs) {
          const deflection = (this.bh.Rs * 35) / dist;
          targetX += (dx / dist) * deflection;
          targetY += (dy / dist) * deflection;
        }

        if (y === 0) this.ctx.moveTo(targetX, targetY);
        else this.ctx.lineTo(targetX, targetY);
      }
      this.ctx.stroke();
    }
  }

  // Draw trace of ray-traced photon beams
  _drawLensingRays() {
    // Spawn horizontal light rays arriving from left to show deflection
    const spacing = 15;
    this.ctx.lineWidth = 1.2;
    for (let y = this.bh.y - 120; y <= this.bh.y + 120; y += spacing) {
      if (Math.abs(y - this.bh.y) < 1) continue;
      const pts = tracePhoton(this.bh, 50, y, this.bh.c_sim * 0.1, 0, 180, 2);
      
      this.ctx.beginPath();
      this.ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        this.ctx.lineTo(pts[i][0], pts[i][1]);
      }
      this.ctx.strokeStyle = 'rgba(255, 235, 50, 0.45)';
      this.ctx.stroke();
    }
  }

  // Run one full physics step
  update(dt) {
    if (this.isPaused) return;

    const adjustedDt = dt * this.timeScale;

    // 1. Spawning continuous disk material if accretion is auto-active
    if (this.autoSpawnAccretion && this.particles.length < 500) {
      for (let i = 0; i < 2; i++) {
        this.particles.push(spawnDiskParticle(this.bh));
      }
    }

    // 2. Continuous jet outflow matching accretion rate
    if (this.bh.accretionRate > 0) {
      const jetSpawns = Math.min(5, Math.ceil(this.bh.accretionRate * 50));
      for (let i = 0; i < jetSpawns; i++) {
        this.jets.push(new JetParticle(this.bh, -1)); // Upward jet
        this.jets.push(new JetParticle(this.bh, 1));  // Downward jet
      }
      this.bh.accretionRate *= 0.94; // Accretion rate decay
    }

    // 3. Update Wave ripples
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.update();
      if (w.dead) this.waves.splice(i, 1);
    }

    // 4. Update jet particles
    for (let i = this.jets.length - 1; i >= 0; i--) {
      const j = this.jets[i];
      j.update(adjustedDt);
      if (j.dead) this.jets.splice(i, 1);
    }

    // 5. Update Spaceship
    if (this.spaceship) {
      this.controlSpaceship(adjustedDt);
    }

    // 6. Update general particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.update(adjustedDt, this.bh);
      if (p.dead) {
        // If star falls into BH, trigger gravitational wave & jet surge
        if (p.type === 'star') {
          this.waves.push(new GravWave(this.bh.x, this.bh.y, { r0: this.bh.Rs, maxR: 500, speed: 5, color: '#f80', alpha: 0.7 }));
          this.bh.grow(5000);
        } else if (p.type === 'planet') {
          this.waves.push(new GravWave(this.bh.x, this.bh.y, { r0: this.bh.Rs, maxR: 700, speed: 6, color: '#a0f', alpha: 0.9 }));
          this.bh.grow(15000);
        }
        this.particles.splice(i, 1);
      }
    }

    // 7. Mouse gravitational pull action
    if (this.mouse.isDown && this.mouse.action === 'pull') {
      const strength = 180 * adjustedDt;
      for (const p of this.particles) {
        const dx = this.mouse.x - p.x;
        const dy = this.mouse.y - p.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > 5) {
          p.vx += (dx / dist) * strength;
          p.vy += (dy / dist) * strength;
        }
      }
    }
  }

  // Handle manual coordinate-based clicks/drags to spawn new matter
  handleMouseAction(action, px, py) {
    if (action === 'spawn_dust') {
      for (let i = 0; i < 30; i++) {
        const angle = Math.random() * 2 * Math.PI;
        const speed = Math.random() * 30 + 10;
        this.particles.push(new Particle(px, py, speed * Math.cos(angle), speed * Math.sin(angle), {
          mass: 0.5,
          radius: 1.5 + Math.random()*2,
          type: 'dust',
          color: `hsl(${Math.random()*40 + 35}, 100%, 60%)`,
          life: 300,
          maxTrail: 40
        }));
      }
    } else if (action === 'spawn_star') {
      // Spawn star orbiting or diving
      const dx = px - this.bh.x;
      const dy = py - this.bh.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      // Tangential velocity for orbital path
      const vOrb = circularOrbitV(this.bh, dist) * (0.8 + Math.random() * 0.4);
      const angle = Math.atan2(dy, dx) + Math.PI / 2;
      const vx = vOrb * Math.cos(angle);
      const vy = vOrb * Math.sin(angle);

      this.particles.push(new Particle(px, py, vx, vy, {
        mass: 3000,
        radius: 4.5,
        type: 'star',
        color: '#ffdd66',
        life: 1200,
        maxTrail: 80
      }));
    }
  }
}

export { Engine };
