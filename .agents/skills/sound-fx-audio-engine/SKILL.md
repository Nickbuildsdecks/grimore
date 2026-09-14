---
name: sound-fx-audio-engine
description: Synthesized Web Audio API sound generator, low-latency audio feedback, card shuffle sound FX, mana tapping shimmers, and spell cast audio cues for Grimore. Make sure to use this skill whenever adding sound feedback, Web Audio oscillators, audio FX, or sound settings.
---

# Web Audio Synthesizer Engine

Implementation guidelines and low-latency audio synthesis code for video game UI sound effects without external `.mp3` asset overhead.

## 🎵 Web Audio Sound Synthesizer

```javascript
class GameAudioSynthesizer {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
  }

  playSound(type) {
    this.init();
    if (!this.ctx || this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);

    switch (type) {
      case 'card_play':
        // Crisp card slide noise
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(450, t);
        osc.frequency.exponentialRampToValueAtTime(120, t + 0.08);
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.08);
        osc.start(t);
        osc.stop(t + 0.08);
        break;

      case 'mana_tap':
        // Shimmering mana tap chime
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.exponentialRampToValueAtTime(1760, t + 0.12);
        gain.gain.setValueAtTime(0.18, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.12);
        osc.start(t);
        osc.stop(t + 0.12);
        break;

      case 'spell_cast':
        // Deep magical spell surge
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, t);
        osc.frequency.exponentialRampToValueAtTime(660, t + 0.25);
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
        osc.start(t);
        osc.stop(t + 0.25);
        break;

      case 'life_gain':
        // Harmonious chord rise
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, t); // C5
        osc.frequency.setValueAtTime(659.25, t + 0.08); // E5
        osc.frequency.setValueAtTime(783.99, t + 0.16); // G5
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
        osc.start(t);
        osc.stop(t + 0.3);
        break;

      case 'life_damage':
        // Low impact combat thud
        osc.type = 'square';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.15);
        gain.gain.setValueAtTime(0.35, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
        osc.start(t);
        osc.stop(t + 0.15);
        break;
    }
  }
}
```

## 🎯 Best Practices
1. **User Gesture Activation**: Initialize `AudioContext` on the first click or touch event to conform to modern browser autoplay policies.
2. **Volume Control**: Provide an audio toggle or volume slider in settings modal.
