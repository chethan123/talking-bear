# Fixtures for the %noloop end-of-file test: 1 s silence + 1 s 1 kHz tone (-12 dBFS),
# with and without a 300 ms digital-zero tail. 48 kHz mono 16-bit PCM.
import math, struct, wave
sr = 48000
def w(name, tail_zeros):
    x = [0.0] * sr + [0.25 * math.sin(2 * math.pi * 1000 * n / sr) for n in range(sr)] + [0.0] * int(sr * tail_zeros)
    with wave.open(name, 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(sr)
        f.writeframes(struct.pack('<%dh' % len(x), *[int(v * 32767) for v in x]))
w('tone_notail.wav', 0); w('tone_tail.wav', 0.3)
print('wrote tone_notail.wav, tone_tail.wav')
