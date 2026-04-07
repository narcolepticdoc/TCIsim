// alert-sound.js

let audioCtx = null;

// Call this once on any user gesture (button click, etc.)
export function unlockAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

/**
 * Play a multi-tone alert pattern
 * @param {'warning'|'urgent'|'info'} level - severity level
 */
export function playAlert(level = 'warning') {
  if (!audioCtx) return; // Audio not yet unlocked

  const patterns = {
    info:    [{ freq: 880, dur: 0.15, gap: 0.05 }],
    redose:  [{ freq: 880, dur: 0.1, gap: 0.05 }, { freq: 880, dur: 0.1, gap: 0 }],
    warning: [
      { freq: 880, dur: 0.2, gap: 0.1 },
      { freq: 880, dur: 0.2, gap: 0.1 },
      { freq: 1100, dur: 0.4, gap: 0 }
    ],
    urgent: [
      { freq: 1200, dur: 0.15, gap: 0.05 },
      { freq: 900,  dur: 0.15, gap: 0.05 },
      { freq: 1200, dur: 0.15, gap: 0.05 },
      { freq: 900,  dur: 0.5,  gap: 0 }
    ]
  };

  const tones = patterns[level] || patterns.warning;
  let time = audioCtx.currentTime + 0.05;

  tones.forEach(({ freq, dur, gap }) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);

    // Smooth envelope to avoid clicks
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.6, time + 0.02);
    gain.gain.linearRampToValueAtTime(0.6, time + dur - 0.02);
    gain.gain.linearRampToValueAtTime(0, time + dur);

    osc.start(time);
    osc.stop(time + dur);

    time += dur + gap;
  });
}
