// BTOWN CROSSINGS — sparse procedural WebAudio. No files, no eager context.

const MUTE_KEY = 'btown-crossings-muted';
const MAX_VOICES = 14;

let context = null;
let master = null;
let muted = readMuted();
const voices = new Set();

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted() {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch { /* private mode — keep the in-memory preference */ }
}

function unlock() {
  if (muted) return;
  if (!context) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    try {
      context = new AudioContext();
      master = context.createGain();
      master.gain.value = 0.28;
      master.connect(context.destination);
    } catch {
      context = null;
      master = null;
      return;
    }
  }
  if (context.state === 'suspended') context.resume().catch(() => {});
}

function tone(frequency, start, duration, {
  type = 'sine',
  gain = 0.07,
  slide = 0,
} = {}) {
  if (muted) return;
  unlock();
  if (!context || !master || voices.size >= MAX_VOICES) return;
  const begins = context.currentTime + start;
  const ends = begins + duration;
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, begins);
  if (slide) {
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(35, frequency + slide),
      ends
    );
  }
  envelope.gain.setValueAtTime(0.0001, begins);
  envelope.gain.exponentialRampToValueAtTime(gain, begins + 0.01);
  envelope.gain.exponentialRampToValueAtTime(0.0001, ends);
  oscillator.connect(envelope).connect(master);
  voices.add(oscillator);
  oscillator.addEventListener('ended', () => {
    voices.delete(oscillator);
    oscillator.disconnect();
    envelope.disconnect();
  }, { once: true });
  oscillator.start(begins);
  oscillator.stop(ends + 0.025);
}

function play(notes) {
  for (const note of notes) tone(...note);
}

export const sound = {
  get muted() {
    return muted;
  },

  unlock,

  stop() {
    for (const voice of [...voices]) {
      try { voice.stop(); } catch { /* already stopped */ }
    }
  },

  toggleMuted() {
    muted = !muted;
    saveMuted();
    if (muted) this.stop();
    else unlock();
    return muted;
  },

  tileClick() {
    tone(520, 0, 0.035, { type: 'triangle', gain: 0.025, slide: 35 });
  },

  tilePlace() {
    play([
      [210, 0, 0.07, { type: 'triangle', gain: 0.045, slide: -55 }],
      [560, 0, 0.025, { gain: 0.018 }],
    ]);
  },

  wordScore(score) {
    const lift = Math.min(240, Math.max(0, score) * 5);
    const notes = [
      [330 + lift * 0.35, 0, 0.13, { type: 'triangle', gain: 0.055 }],
      [440 + lift * 0.55, 0.07, 0.18, { type: 'triangle', gain: 0.065 }],
    ];
    if (score >= 25) {
      notes.push([587 + lift, 0.14, 0.22, { type: 'triangle', gain: 0.075 }]);
    }
    play(notes);
  },

  fullBucket(score) {
    const lift = Math.min(180, Math.max(0, score) * 3);
    play([
      [330 + lift * 0.2, 0, 0.15, { type: 'triangle', gain: 0.07 }],
      [440 + lift * 0.35, 0.08, 0.18, { type: 'triangle', gain: 0.075 }],
      [554, 0.16, 0.2, { type: 'triangle', gain: 0.08 }],
      [659, 0.24, 0.24, { type: 'triangle', gain: 0.085 }],
      [880, 0.35, 0.42, { type: 'triangle', gain: 0.09 }],
    ]);
  },

  win() {
    play([
      [392, 0, 0.18, { type: 'triangle', gain: 0.065 }],
      [523, 0.11, 0.2, { type: 'triangle', gain: 0.07 }],
      [659, 0.22, 0.24, { type: 'triangle', gain: 0.075 }],
      [784, 0.35, 0.45, { type: 'triangle', gain: 0.08 }],
    ]);
  },

  lose() {
    play([
      [330, 0, 0.2, { type: 'triangle', gain: 0.055 }],
      [262, 0.14, 0.24, { type: 'triangle', gain: 0.06 }],
      [220, 0.3, 0.32, { type: 'triangle', gain: 0.052 }],
    ]);
  },

  draw() {
    play([
      [294, 0, 0.3, { type: 'triangle', gain: 0.05 }],
      [330, 0, 0.3, { type: 'triangle', gain: 0.045 }],
    ]);
  },
};
