// ── Cinematic Particle Background ──
// Creates a living, breathing neural-network canvas behind the entire page.
// Phase-aware: colors shift based on the current act (scan→generate→xray→complete).

const PARTICLE_COUNT = 80;
const CONNECTION_DISTANCE = 140;
const PARTICLE_SPEED = 0.35;

let canvas, ctx;
let particles = [];
let animFrame = null;
let currentPhaseColor = { r: 56, g: 189, b: 248 }; // neon-blue default
let targetPhaseColor = { r: 56, g: 189, b: 248 };

const PHASE_COLORS = {
  idle:       { r: 56,  g: 189, b: 248 },  // blue
  scanning:   { r: 56,  g: 189, b: 248 },  // blue
  generating: { r: 0,   g: 255, b: 153 },  // green
  xray:       { r: 245, g: 158, b: 11  },  // amber
  complete:   { r: 0,   g: 255, b: 153 },  // green
};

class Particle {
  constructor(w, h) {
    this.x = Math.random() * w;
    this.y = Math.random() * h;
    this.vx = (Math.random() - 0.5) * PARTICLE_SPEED * 2;
    this.vy = (Math.random() - 0.5) * PARTICLE_SPEED * 2;
    this.radius = Math.random() * 1.8 + 0.6;
    this.baseAlpha = Math.random() * 0.4 + 0.15;
    this.pulseOffset = Math.random() * Math.PI * 2;
  }
  update(w, h, time) {
    this.x += this.vx;
    this.y += this.vy;
    if (this.x < 0 || this.x > w) this.vx *= -1;
    if (this.y < 0 || this.y > h) this.vy *= -1;
    this.alpha = this.baseAlpha + Math.sin(time * 0.002 + this.pulseOffset) * 0.1;
  }
}

export function initParticles() {
  canvas = document.getElementById('particle-canvas');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  spawnParticles();
  loop();
}

function resize() {
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

function spawnParticles() {
  particles = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push(new Particle(canvas.width, canvas.height));
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

function loop() {
  if (!ctx) return;
  const time = performance.now();
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Lerp phase color
  currentPhaseColor.r = lerp(currentPhaseColor.r, targetPhaseColor.r, 0.02);
  currentPhaseColor.g = lerp(currentPhaseColor.g, targetPhaseColor.g, 0.02);
  currentPhaseColor.b = lerp(currentPhaseColor.b, targetPhaseColor.b, 0.02);

  const cr = Math.round(currentPhaseColor.r);
  const cg = Math.round(currentPhaseColor.g);
  const cb = Math.round(currentPhaseColor.b);

  // Update & draw particles
  for (const p of particles) {
    p.update(w, h, time);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${cr},${cg},${cb},${p.alpha})`;
    ctx.fill();
  }

  // Draw connections
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[i].x - particles[j].x;
      const dy = particles[i].y - particles[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < CONNECTION_DISTANCE) {
        const alpha = (1 - dist / CONNECTION_DISTANCE) * 0.12;
        ctx.beginPath();
        ctx.moveTo(particles[i].x, particles[i].y);
        ctx.lineTo(particles[j].x, particles[j].y);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha})`;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }
  }

  animFrame = requestAnimationFrame(loop);
}

export function setParticlePhase(phase) {
  if (PHASE_COLORS[phase]) {
    targetPhaseColor = { ...PHASE_COLORS[phase] };
  }
}

export function destroyParticles() {
  if (animFrame) cancelAnimationFrame(animFrame);
  particles = [];
}
