---
name: canvas-particles-shaders
description: HTML5 Canvas particle systems, interactive background shaders, floating mana embers, aura particle bursts, and dynamic canvas effects for Grimore. Make sure to use this skill whenever building particle backgrounds, spell casting aura effects, or ambient canvas visuals.
---

# HTML5 Canvas Particle Systems & Ambient Shaders

Complete engine architecture and code patterns for building high-performance 60fps HTML5 Canvas particle effects for video game web applications.

## 🌟 Interactive Mana Embers Particle Engine

```javascript
class ManaEmbersCanvas {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.maxParticles = 50;
    this.init();
  }

  init() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.createParticles();
    this.animate();
  }

  resize() {
    this.canvas.width = this.canvas.parentElement.clientWidth || window.innerWidth;
    this.canvas.height = this.canvas.parentElement.clientHeight || window.innerHeight;
  }

  createParticles() {
    for (let i = 0; i < this.maxParticles; i++) {
      this.particles.push({
        x: Math.random() * this.canvas.width,
        y: Math.random() * this.canvas.height,
        radius: Math.random() * 2 + 0.5,
        color: Math.random() > 0.5 ? 'rgba(168, 85, 247, ' : 'rgba(245, 200, 66, ',
        alpha: Math.random() * 0.5 + 0.2,
        speedY: -(Math.random() * 0.4 + 0.1),
        speedX: (Math.random() - 0.5) * 0.3,
        pulseSpeed: Math.random() * 0.02 + 0.005,
      });
    }
  }

  animate() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.particles.forEach(p => {
      p.y += p.speedY;
      p.x += p.speedX;
      p.alpha += Math.sin(Date.now() * p.pulseSpeed) * 0.005;

      if (p.y < -10) p.y = this.canvas.height + 10;
      if (p.x < 0) p.x = this.canvas.width;
      if (p.x > this.canvas.width) p.x = 0;

      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      this.ctx.fillStyle = p.color + Math.max(0.1, Math.min(0.8, p.alpha)) + ')';
      this.ctx.shadowBlur = 8;
      this.ctx.shadowColor = p.color + '0.8)';
      this.ctx.fill();
    });

    requestAnimationFrame(() => this.animate());
  }
}
```

## ⚡ Integration Guide
1. Place canvas as a fixed/absolute container with `pointer-events: none;` behind UI panels.
2. Monitor device performance and automatically scale particle count on lower-end devices.
