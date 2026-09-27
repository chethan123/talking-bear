# Synthetic "speech-like" fixture: silence / voiced harmonic burst / silence, 48 kHz 16-bit mono PCM.
import math, struct, wave, random, sys
sr = int(sys.argv[2]) if len(sys.argv) > 2 else 48000
out = sys.argv[1]
random.seed(1)
lead, speech, tail = 1.0, 1.5, 2.0
f0 = 150.0
n_total = int(sr * (lead + speech + tail))
frames = []
for n in range(n_total):
    t = n / sr
    s = 0.0
    # low-level background noise (~ -60 dBFS)
    s += (random.random() * 2 - 1) * 0.001
    if lead <= t < lead + speech:
        ts = t - lead
        env = 0.5 * (1 - math.cos(2 * math.pi * 4.0 * ts))  # 4 Hz syllable modulation
        env *= min(1.0, ts / 0.02, (speech - ts) / 0.02)
        v = sum((1.0 / k) * math.sin(2 * math.pi * f0 * k * ts) for k in range(1, 12))
        s += 0.3 * env * v
    frames.append(max(-32768, min(32767, int(s * 32767))))
with wave.open(out, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(struct.pack('<%dh' % len(frames), *frames))
print(out, n_total, 'samples')
