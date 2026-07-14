---
name: background-animation-design
description: Design, implement, and optimize premium interactive canvas backgrounds that react smoothly to user input while maintaining high performance and readability.
---

# Interactive Background Canvas Design Skill

This skill provides guidelines and patterns for creating premium, high-performance interactive backgrounds using HTML5 `<canvas>` that adapt to user events (e.g. mouse cursor movements) without causing visual distraction or high CPU load.

## Core Design Principles

### 1. Readability First
- **Dark Mode Palette**: Keep background canvas fills extremely dark (e.g., values near `#050508` to `#0a0b12`).
- **Low Contrast Details**: Set background shapes, lines, and particle opacities to very low values (usually `0.02` to `0.18`).
- **Aesthetic Depth**: Ensure text, cards, and primary panels remain 100% legible. Background visual elements must sit firmly behind content.

### 2. High Performance (60 FPS)
- **Math Over Physics Engines**: Use trigonometric waves (sine/cosine curves, Lissajous drift) to simulate fluid movement instead of calculating complex particle-on-particle physics or dense noise grids.
- **Resource Management**: Limit active background elements (nodes, particles, circles) to a sensible number (e.g. 50-100 for lines/plexus, 300-400 for micro-particles).
- **Efficient Clears**: Avoid drawing unnecessary shapes. Prefer full-canvas fills or small trail masks (`rgba(8,7,14,0.08)`) to clear previous frames.

### 3. Responsive Interaction
- **Inertia Tracking**: Instead of snapping directly to client coordinates, interpolate mouse movements smoothly:
  ```javascript
  mouse.x += (mouse.targetX - mouse.x) * 0.08;
  mouse.y += (mouse.targetY - mouse.y) * 0.08;
  ```
- **Proximity-Based Effects**: Light up, connect, or accelerate elements only when they enter a specific distance radius (e.g., 200px - 250px) around the mouse.
- **Graceful Deactivation**: Safely handle mouse-out and tab-inactive events to stop drawing or return elements to rest states.

---

## Technical Implementations

### Plexus Constellation Network
A clean, minimal style where lines connect nearby nodes that drift slowly. The entire network lights up and responds dynamically around the user's cursor.

```javascript
function initConstellationBG(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  let raf;

  const nodes = [];
  const GRID_COLS = 10;
  const GRID_ROWS = 8;
  let mouse = { x: -1000, y: -1000, targetX: -1000, targetY: -1000, active: false };

  function initGrid(w, h) {
    nodes.length = 0;
    const cellW = w / GRID_COLS;
    const cellH = h / GRID_ROWS;

    for (let c = 0; c < GRID_COLS; c++) {
      for (let r = 0; r < GRID_ROWS; r++) {
        const homeX = cellW * (c + 0.1 + Math.random() * 0.8);
        const homeY = cellH * (r + 0.1 + Math.random() * 0.8);
        nodes.push({
          x: homeX, y: homeY,
          homeX: homeX, homeY: homeY,
          angle: Math.random() * Math.PI * 2,
          orbitRad: Math.random() * 5 + 3,
          orbitSpeed: Math.random() * 0.005 + 0.002,
          size: Math.random() * 1.5 + 1
        });
      }
    }
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    initGrid(canvas.width, canvas.height);
  }

  function onMouseMove(e) {
    mouse.targetX = e.clientX;
    mouse.targetY = e.clientY;
    mouse.active = true;
  }

  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', onMouseMove);
  resize();

  function draw() {
    ctx.fillStyle = '#06050a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Smooth mouse coordinates
    mouse.x += (mouse.targetX - mouse.x) * 0.08;
    mouse.y += (mouse.targetY - mouse.y) * 0.08;

    // Node updates & drawing
    nodes.forEach(node => {
      node.angle += node.orbitSpeed;
      const tx = node.homeX + Math.sin(node.angle) * node.orbitRad;
      const ty = node.homeY + Math.cos(node.angle) * node.orbitRad;
      
      node.x += (tx - node.x) * 0.08;
      node.y += (ty - node.y) * 0.08;

      ctx.fillStyle = 'rgba(168, 85, 247, 0.15)';
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.size, 0, Math.PI * 2);
      ctx.fill();
    });

    raf = requestAnimationFrame(draw);
  }
  draw();

  return function cleanup() {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    window.removeEventListener('mousemove', onMouseMove);
  };
}
```

---

## Prevention of Memory Leaks
Always return a **cleanup function** from background initializers. When tearing down or transitioning pages, execute the cleanup function to:
1. Call `cancelAnimationFrame(raf)` to stop the draw loop thread.
2. Remove all attached event listeners (`resize`, `mousemove`, `mouseleave`).
3. Set the canvas styling `display` value to `none` to free up GPU frame buffers.
