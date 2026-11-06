#!/usr/bin/env python3
"""Synthèse Kokoro pour le banc de la reconnaissance vocale (scripts/stt-bench).

Lit sur stdin une ligne JSON par phrase : {"text", "speed", "out"}, et écrit
chaque phrase en WAV 24 kHz mono 16 bits dans "out" (la voix de Kopilia,
ff_siwis). Le modèle est chargé une seule fois. Une ligne « ok <out> » par
fichier sur stdout ; les journaux vont sur stderr.
"""
import json
import sys


def main():
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline

    pipeline = KPipeline(lang_code="f", repo_id="hexgrad/Kokoro-82M")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        chunks = [np.asarray(r.audio, dtype="float32") for r in pipeline(job["text"], voice="ff_siwis", speed=job.get("speed", 1.0)) if r.audio is not None]
        audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype="float32")
        sf.write(job["out"], np.clip(audio, -1.0, 1.0), 24000, subtype="PCM_16")
        sys.stdout.write(f"ok {job['out']}\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
