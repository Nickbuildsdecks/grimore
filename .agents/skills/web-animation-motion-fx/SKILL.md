---
name: web-animation-motion-fx
description: 60fps GPU-accelerated CSS animations, 3D card tilt physics, portal transitions, spring keyframes, and UI motion effects for Grimore. Make sure to use this skill whenever building smooth UI transitions, card movement keyframes, pulse glows, or interactive motion effects.
---

# Web Animation & Motion FX Engine

Guidelines and code patterns for implementing fluid 60fps animations, 3D perspective tilts, and spring keyframe motion in web games.

## 🌀 3D Cursor Motion Card Tilt

```javascript
function applyCard3DTilt(cardElement) {
  cardElement.addEventListener('mousemove', (e) => {
    const rect = cardElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const rotateX = ((y - centerY) / centerY) * -14;
    const rotateY = ((x - centerX) / centerX) * 14;

    cardElement.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.05)`;
  });

  cardElement.addEventListener('mouseleave', () => {
    cardElement.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale(1)';
  });
}
```

## ⚡ Keyframe CSS Motion Effects

```css
/* Card Entrance Animation */
@keyframes cardPlayEntrance {
  0% {
    opacity: 0;
    transform: scale(0.6) translateY(40px) rotate(-6deg);
  }
  70% {
    transform: scale(1.08) translateY(-4px) rotate(1deg);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0) rotate(0deg);
  }
}
.card-entrance {
  animation: cardPlayEntrance 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

/* Glowing Pulsing Stack Item */
@keyframes magicalSpellPulse {
  0%, 100% {
    box-shadow: 0 0 15px rgba(168, 85, 247, 0.4), inset 0 0 10px rgba(168, 85, 247, 0.2);
  }
  50% {
    box-shadow: 0 0 30px rgba(168, 85, 247, 0.8), inset 0 0 20px rgba(168, 85, 247, 0.5);
  }
}
.stack-spell-pulse {
  animation: magicalSpellPulse 1.8s infinite ease-in-out;
}
```

## 🚀 Performance Rules
1. **GPU Acceleration**: Always animate `transform` and `opacity` to avoid triggering layout reflows.
2. **Will-Change Hint**: Use `will-change: transform;` sparingly on active dragging elements.
3. **Transition Timing**: Use spring-like cubic beziers `cubic-bezier(0.16, 1, 0.3, 1)` for snappy game responses.
