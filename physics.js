/**
 * physics.js — Relativistic & Newtonian physics engine for Black Hole Simulator
 *
 * Physical model:
 *  - Schwarzschild metric (non-rotating black hole) for photon & particle orbits
 *  - Geodesic integration via 4th-order Runge-Kutta in polar coords (r, φ)
 *  - Innermost Stable Circular Orbit (ISCO) at r = 6GM/c² = 3·Rs
 *  - Photon sphere at r = 1.5·Rs
 *  - Accretion disk thermal spectrum: T(r) ∝ (1/r³ - 1/(r·Rs))^(1/4)
 *  - Gravitational time dilation: τ = t·√(1 - Rs/r)
 *  - Hawking temperature: T_H = ℏc³/(8πGMk_B) — shown in HUD
 *  - Tidal force approximation: F_tidal ∝ 2GMd/r³
 *  - Newtonian gravity for test particles (fast, good enough for interactive sim)
 *  - Relativistic correction factor applied near Schwarzschild radius
 */

'use strict';

// ─── Physical Constants (SI, then scaled for simulation) ──────────────────────
export const C = {
  G: 6.674e-11,        // gravitational constant m³ kg⁻¹ s⁻²
  c: 3e8,              // speed of light m/s
  hbar: 1.055e-34,     // reduced Planck constant J·s
  kB: 1.38e-23,        // Boltzmann constant J/K
  sigma: 5.67e-8,      // Stefan–Boltzmann constant W m⁻² K⁻⁴
};

/**
 * BlackHole — the central mass object
 * All internal units are "simulation units" where:
 *   1 sim-length ≈ screen pixel, mass in arbitrary units,
 *   G_sim chosen so that Rs = 2·G_sim·M / c_sim² gives a visible radius.
 */
export class BlackHole {
  constructor(x, y, opts = {}) {
    this.x = x;
    this.y = y;
    this.mass = opts.mass ?? 1e6;          // simulation mass units
    this.G_sim = opts.G_sim ?? 1.0;        // simulation G (dimensionless)
    this.c_sim = opts.c_sim ?? 300;        // simulation c (pixels/step)

    // Schwarzschild radius in sim pixels
    this.Rs = 2 * this.G_sim * this.mass / (this.c_sim * this.c_sim);

    // Key orbital radii
    this.r_photon = 1.5 * this.Rs;        // photon sphere
    this.r_isco   = 3.0 * this.Rs;        // ISCO (innermost stable circular orbit)
    this.r_disk_outer = opts.diskOuter ?? Math.max(180, this.Rs * 30);

    // Accretion rate (visual effect modulator)
    this.accretionRate = 0;
    this.totalAccreted = 0;

    // Spin parameter a ∈ [0,1] — Kerr factor for future extension
    this.spin = opts.spin ?? 0;

    // Hawking temperature (physical, for display — not used in force calc)
    // T_H = ℏ c³ / (8π G M k_B)  →  scaled to K using a nominal mass mapping
    this.nominalMassKg = opts.nominalMassKg ?? (this.mass * 1e25);
    this._updateHawking();
  }

  _updateHawking() {
    const M = this.nominalMassKg;
    this.hawkingTempK = (C.hbar * C.c ** 3) / (8 * Math.PI * C.G * M * C.kB);
    // Luminosity via Stefan–Boltzmann on a sphere of radius Rs (nominal SI)
    const RsM = 2 * C.G * M / (C.c * C.c);
    this.hawkingLuminosity = C.sigma * 4 * Math.PI * RsM * RsM * this.hawkingTempK ** 4;
  }

  grow(dm) {
    this.mass += dm;
    this.totalAccreted += dm;
    this.accretionRate += dm;
    this.Rs = 2 * this.G_sim * this.mass / (this.c_sim * this.c_sim);
    this.r_photon = 1.5 * this.Rs;
    this.r_isco   = 3.0 * this.Rs;
    this.nominalMassKg = this.mass * 1e25;
    this._updateHawking();
  }

  /** Newtonian gravitational acceleration vector on a test particle at (px,py) */
  gravity(px, py) {
    const dx = this.x - px;
    const dy = this.y - py;
    const r2 = dx * dx + dy * dy;
    const r  = Math.sqrt(r2);
    if (r < 0.1) return { ax: 0, ay: 0, r };

    // Newtonian: a = GM/r²  (direction toward BH)
    const aN = this.G_sim * this.mass / r2;

    // GR post-Newtonian correction: multiply by (1 + 3·Rs/r + ...) ≈ Schwarzschild factor
    // Derived from the effective potential: V_eff = -GM/r + L²/(2r²) - GML²/(r³c²)
    const relCorr = 1 + 3 * this.Rs / (2 * r) + (this.Rs / r) ** 2;
    const a = aN * relCorr;

    return { ax: a * dx / r, ay: a * dy / r, r, aN, relCorr };
  }

  /** Time dilation factor at radius r: √(1 − Rs/r).  Returns 1 if r >> Rs. */
  timeDilation(r) {
    if (r <= this.Rs) return 0;
    return Math.sqrt(Math.max(0, 1 - this.Rs / r));
  }

  /** Disk temperature profile (normalized 0→1 for colour mapping) */
  diskTemp(r) {
    if (r <= this.r_isco) return 1;
    // Novikov–Thorne temperature profile (simplified):
    //   T ∝ (1/r³ · (1 − √(r_isco/r)))^(1/4)
    const x  = this.r_isco / r;
    const T4 = (1 / (r * r * r)) * (1 - Math.sqrt(x));
    return Math.max(0, T4) ** 0.25;   // return relative temperature
  }

  /** Tidal acceleration difference across an object of size d at distance r */
  tidalAcc(r, d) {
    return 2 * this.G_sim * this.mass * d / (r * r * r);
  }

  /**
   * Photon deflection angle (weak-field lensing):
   *   δφ = 4GM/(c²b) = 2Rs/b   where b = impact parameter
   */
  lensDeflection(b) {
    return 2 * this.Rs / Math.max(b, this.Rs * 0.1);
  }
}

// ─── Particle ──────────────────────────────────────────────────────────────────
export class Particle {
  constructor(x, y, vx, vy, opts = {}) {
    this.x  = x;  this.y  = y;
    this.vx = vx; this.vy = vy;
    this.mass   = opts.mass   ?? 1;
    this.radius = opts.radius ?? 2;
    this.type   = opts.type   ?? 'dust';   // 'dust'|'star'|'planet'|'photon'|'debris'
    this.color  = opts.color  ?? '#ffffff';
    this.life   = opts.life   ?? Infinity;
    this.age    = 0;
    this.trail  = [];
    this.maxTrail = opts.maxTrail ?? 80;
    this.dead   = false;
    this.spaghettied = false;
    this.inDisk = false;
    this.temp   = opts.temp ?? 1;          // normalised temperature (0–1)
    this.glow   = opts.glow ?? 1;
    this.id     = Particle._nextId++;
  }

  update(dt, bh) {
    if (this.dead) return;
    this.age += dt;

    // Push current position to trail
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > this.maxTrail) this.trail.shift();

    const { ax, ay, r } = bh.gravity(this.x, this.y);

    // Inside event horizon → gone
    if (r <= bh.Rs * 1.05) {
      bh.grow(this.mass * 0.01);
      this.dead = true;
      return;
    }

    // Tidal spaghettification check
    if (r < bh.Rs * 4 && !this.spaghettied) {
      const ft = bh.tidalAcc(r, this.radius);
      if (ft > 50) this.spaghettied = true;
    }

    // Time dilation factor affects perceived motion (visual only)
    const td = bh.timeDilation(r);
    const dtEff = dt * td;

    // Symplectic-Euler integration
    this.vx += ax * dtEff;
    this.vy += ay * dtEff;

    // Velocity cap at 0.95c_sim
    const v2 = this.vx * this.vx + this.vy * this.vy;
    const vMax = bh.c_sim * 0.95;
    if (v2 > vMax * vMax) {
      const scale = vMax / Math.sqrt(v2);
      this.vx *= scale;
      this.vy *= scale;
    }

    this.x += this.vx * dtEff;
    this.y += this.vy * dtEff;

    // Age-based death
    if (this.age > this.life) this.dead = true;
  }
}
Particle._nextId = 0;

// ─── Jet (relativistic outflow) ────────────────────────────────────────────────
export class JetParticle {
  constructor(bh, sign, opts = {}) {
    // Launched along BH spin axis (vertical)
    this.x  = bh.x + (Math.random() - 0.5) * bh.Rs * 0.3;
    this.y  = bh.y;
    const speed = bh.c_sim * (0.5 + Math.random() * 0.45);
    this.vx = (Math.random() - 0.5) * speed * 0.1;
    this.vy = sign * speed;
    this.life = opts.life ?? (60 + Math.random() * 40);
    this.age  = 0;
    this.dead = false;
    this.alpha = 1;
    this.r = 2 + Math.random() * 3;
  }

  update(dt) {
    if (this.dead) return;
    this.age += dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.alpha = 1 - this.age / this.life;
    if (this.age >= this.life) this.dead = true;
  }
}

// ─── Gravitational Wave (visual ripple) ────────────────────────────────────────
export class GravWave {
  constructor(x, y, opts = {}) {
    this.x = x; this.y = y;
    this.r = opts.r0 ?? 0;
    this.maxR = opts.maxR ?? 600;
    this.speed = opts.speed ?? 4;
    this.alpha = opts.alpha ?? 0.6;
    this.color = opts.color ?? '#7af';
    this.dead = false;
  }
  update() {
    this.r += this.speed;
    this.alpha *= 0.97;
    if (this.r > this.maxR || this.alpha < 0.01) this.dead = true;
  }
}

// ─── RK4 geodesic integrator for photon ray tracing (2D polar) ─────────────────
/**
 * Integrate a null geodesic around a Schwarzschild BH.
 * State: [r, dr/dλ, φ, dφ/dλ]  (λ = affine parameter)
 * EOM in Schwarzschild coords (c=G=1, M=1):
 *   (dr/dλ)' = r·(dφ/dλ)² · (1 - Rs/r) - (Rs/2) / r² · (dr/dλ)² / (1-Rs/r)
 *              ... simplified effective-potential form for equatorial orbit
 *
 * We use the conserved quantities E (energy), L (angular momentum):
 *   (dr/dλ)² = E² - (1-Rs/r)·L²/r²          [null geodesic]
 *   dφ/dλ    = L/r²
 */
export function tracePhoton(bh, x0, y0, dx0, dy0, steps = 300, stepSize = 2) {
  const M  = bh.Rs / 2;   // G=1, c=1, so Rs=2M
  const rs = bh.Rs;

  // Convert Cartesian to polar relative to BH
  let rx = x0 - bh.x;
  let ry = y0 - bh.y;
  let r  = Math.sqrt(rx * rx + ry * ry);
  let phi = Math.atan2(ry, rx);

  // Velocity in polar
  let dr  = (rx * dx0 + ry * dy0) / r;
  let dphi = (rx * dy0 - ry * dx0) / (r * r);  // L/r²

  const L = r * r * dphi;   // specific angular momentum (conserved)
  const b = Math.abs(L);    // impact parameter (L/E, E=1 for unit speed)

  const pts = [];

  for (let i = 0; i < steps; i++) {
    // Cartesian position
    const cx = bh.x + r * Math.cos(phi);
    const cy = bh.y + r * Math.sin(phi);
    pts.push([cx, cy]);

    if (r < rs * 1.02) break;   // captured

    // RK4 step on (r, dr) using effective potential
    // V_eff = (1 - rs/r) * b²/r²
    // (dr/dλ)² = 1 - V_eff  (E=1)
    const k1r  = dr;
    const k1dr = _drddlambda(r, dr, b, rs);
    const r2   = r  + 0.5 * stepSize * k1r;
    const dr2  = dr + 0.5 * stepSize * k1dr;
    const k2r  = dr2;
    const k2dr = _drddlambda(r2, dr2, b, rs);
    const r3   = r  + 0.5 * stepSize * k2r;
    const dr3  = dr + 0.5 * stepSize * k2dr;
    const k3r  = dr3;
    const k3dr = _drddlambda(r3, dr3, b, rs);
    const r4   = r  + stepSize * k3r;
    const dr4  = dr + stepSize * k3dr;
    const k4r  = dr4;
    const k4dr = _drddlambda(r4, dr4, b, rs);

    r  += (stepSize / 6) * (k1r  + 2 * k2r  + 2 * k3r  + k4r);
    dr += (stepSize / 6) * (k1dr + 2 * k2dr + 2 * k3dr + k4dr);

    // dφ/dλ = L/r²
    phi += (stepSize / 6) * (
      L / (r ** 2) + 2 * L / (r2 ** 2) + 2 * L / (r3 ** 2) + L / (r4 ** 2)
    );

    if (r > 3000) break;  // escaped
  }

  return pts;
}

function _drddlambda(r, dr, b, rs) {
  // d²r/dλ² from geodesic eq:
  // Using: (dr/dλ)² = 1 - (1 - rs/r)·b²/r²
  // Differentiating: 2(dr/dλ)(d²r/dλ²) = -b²·d/dr[(1-rs/r)/r²]
  //  d/dr[(1-rs/r)/r²] = d/dr[1/r² - rs/r³]
  //                    = -2/r³ + 3rs/r⁴
  const dVdr = -b * b * (-2 / (r ** 3) + 3 * rs / (r ** 4));
  if (Math.abs(dr) < 1e-10) return 0;
  return -dVdr / (2 * dr);
}

// ─── Accretion Disk particle generator ─────────────────────────────────────────
export function spawnDiskParticle(bh, opts = {}) {
  const rMin = bh.r_isco * 1.1;
  const rMax = bh.r_disk_outer;
  const r = rMin + Math.random() * (rMax - rMin);
  const angle = Math.random() * 2 * Math.PI;

  // Keplerian orbital speed: v = √(GM/r) with GR correction
  const vK = Math.sqrt(bh.G_sim * bh.mass / r);
  const vGR = vK * (1 + 0.5 * bh.Rs / r);  // first-order GR boost

  const px = bh.x + r * Math.cos(angle);
  const py = bh.y + r * Math.sin(angle);
  // Tangential velocity (perpendicular to radius)
  const vx = -vGR * Math.sin(angle) + (Math.random() - 0.5) * vK * 0.05;
  const vy =  vGR * Math.cos(angle) + (Math.random() - 0.5) * vK * 0.05;

  const t = bh.diskTemp(r);
  const color = diskTempColor(t);

  return new Particle(px, py, vx, vy, {
    mass: opts.mass ?? 0.1,
    radius: 1.5 + Math.random() * 1.5,
    type: 'disk',
    color,
    maxTrail: 30,
    temp: t,
    glow: t,
    life: opts.life ?? (400 + Math.random() * 400),
  });
}

/** Map accretion disk temperature (0–1) to a colour:
 *  outer (cold) = deep red → orange → yellow → white (hot, inner) → blue-white */
export function diskTempColor(t) {
  // t=0 → dim red, t=1 → blue-white
  if (t < 0.25) {
    const s = t / 0.25;
    return `rgb(${Math.round(180 * s)},${Math.round(30 * s)},0)`;
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    return `rgb(${Math.round(180 + 60 * s)},${Math.round(80 * s + 30)},0)`;
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    return `rgb(255,${Math.round(110 + 100 * s)},${Math.round(40 * s)})`;
  } else {
    const s = (t - 0.75) / 0.25;
    return `rgb(255,${Math.round(210 + 45 * s)},${Math.round(40 + 215 * s)})`;
  }
}

// ─── Orbital mechanics helpers ──────────────────────────────────────────────────

/** Circular orbit velocity at radius r */
export function circularOrbitV(bh, r) {
  return Math.sqrt(bh.G_sim * bh.mass / Math.max(r, bh.r_isco));
}

/** Specific orbital energy (Newtonian + first GR correction) */
export function orbitalEnergy(bh, r, v) {
  const kinetic = 0.5 * v * v;
  const potential = -bh.G_sim * bh.mass / r;
  const grCorr = -bh.G_sim * bh.mass * bh.Rs / (r * r);
  return kinetic + potential + grCorr;
}

/** Eccentricity from position and velocity */
export function orbitalEccentricity(bh, px, py, vx, vy) {
  const dx = px - bh.x, dy = py - bh.y;
  const r  = Math.sqrt(dx * dx + dy * dy);
  const v2 = vx * vx + vy * vy;
  const mu = bh.G_sim * bh.mass;
  const E  = v2 / 2 - mu / r;
  const Lz = dx * vy - dy * vx;   // specific angular momentum
  const e  = Math.sqrt(Math.max(0, 1 + 2 * E * Lz * Lz / (mu * mu)));
  return e;
}
