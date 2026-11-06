#!/usr/bin/env python3
"""Synthèse de contrôle : force le téléchargement des poids Kokoro-82M et de la
voix ff_siwis, et vérifie que la chaîne française fonctionne. Écrit un court WAV
de contrôle dans models/kokoro-warmup.wav. À exécuter par le bootstrap."""
import os
import sys
import wave

VOICE = os.environ.get("KOPILIA_KOKORO_VOICE", "ff_siwis")
LANG = os.environ.get("KOPILIA_KOKORO_LANG", "f")
SAMPLE_RATE = 24000
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "models", "kokoro-warmup.wav")


def main():
    from kokoro import KPipeline
    import numpy as np

    pipeline = KPipeline(lang_code=LANG)
    chunks = []
    for _gs, _ps, audio in pipeline("Bonjour, je suis Kopilia. La synthèse vocale fonctionne.", voice=VOICE):
        chunks.append(np.asarray(audio, dtype="float32"))
    if not chunks:
        print("Aucun audio produit.", file=sys.stderr)
        sys.exit(1)
    pcm = np.clip(np.concatenate(chunks), -1.0, 1.0)
    data = (pcm * 32767.0).astype("<i2").tobytes()
    with wave.open(OUT, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(data)
    print(f"Synthèse de contrôle OK ({len(data)//2} échantillons) -> {OUT}")


if __name__ == "__main__":
    main()
