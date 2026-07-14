---
name: premium-web-design
description: Rules and guidelines for creating premium, high-aesthetic web interfaces. Handles color palette creation (dark theme with color-primary, border-light, etc.), glassmorphism, responsive grids, micro-interactions, canvas-based particle animations, and transitions. Use whenever the user requests visual updates, styling changes, animation additions, or interface redesigns.
---

# Premium Web Design & High-Aesthetic UI System

This skill defines the token parameters, transition speeds, color standards, and styling methods required to build premium, immersive, and high-fidelity user interfaces.

## 1. Visual Aesthetics & Tokens

### Harmonious HSL/RGB Palettes
Avoid flat primary hex codes (like `#ff0000` or `#0000ff`). Use layered gradients and dark theme backgrounds:
- **Background Main**: `rgb(10, 10, 12)` (Very dark obsidian blue/gray)
- **Primary Accent**: `rgb(37, 99, 235)` (Royal Blue)
- **Secondary Accent**: `rgb(147, 51, 234)` (Purple)
- **Border Light**: `rgba(255, 255, 255, 0.08)`
- **Border Medium**: `rgba(255, 255, 255, 0.15)`

### CSS Glassmorphism
Use translucent backdrops with thin borders to create depth:
```css
.panel-premium {
  background: rgba(20, 20, 25, 0.65);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
}
```

---

## 2. Micro-interactions & Motion

### Smooth Transitions
Always specify transition properties, durations, and timing curves rather than jumping states:
```css
.interactive-element {
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1),
              background-color 0.2s ease,
              border-color 0.2s ease;
}
.interactive-element:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 255, 255, 0.25);
}
```

---

## 3. Dynamic Canvas Backgrounds

To implement floating particles, smoke wisps, or rotating elements behind the content:
1. Create a full-screen canvas element positioned fixed behind everything (`z-index: -1`).
2. Run an animation loop using `requestAnimationFrame`.

### Example Particle Background Animation
```javascript
function initBackgroundCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let animationFrameId;

  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  window.addEventListener('resize', resize);
  resize();

  const particles = [];
  for (let i = 0; i < 40; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      radius: Math.random() * 2 + 1,
      speedY: -(Math.random() * 0.4 + 0.1),
      opacity: Math.random() * 0.5 + 0.1
    });
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    particles.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(147, 51, 234, ${p.opacity})`;
      ctx.fill();
      
      p.y += p.speedY;
      if (p.y < -10) {
        p.y = canvas.height + 10;
        p.x = Math.random() * canvas.width;
      }
    });

    animationFrameId = requestAnimationFrame(animate);
  }
  animate();

  return () => {
    window.removeEventListener('resize', resize);
    cancelAnimationFrame(animationFrameId);
  };
}
```
---

## 4. Typography Rules
- Use premium sans-serif fonts such as `Outfit`, `Inter`, or `Roboto` from Google Fonts.
- Set heading sizes proportionally with strict hierarchy (`h1` = 2.2rem, `h2` = 1.6rem, `h3` = 1.2rem, body = 0.9rem).
- Utilize letter-spacing (`letter-spacing: -0.025em`) for large headers to feel modern and premium.
