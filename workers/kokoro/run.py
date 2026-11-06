#!/usr/bin/env python3
"""Worker TTS Kokoro-82M (protocole NDJSON de packages/contracts).

Reçoit du texte français, synthétise avec la voix ff_siwis (lang 'f') et émet
du PCM 16 bits à 24 kHz, tranche par tranche, en base64. Le modèle est chargé
une seule fois, et chauffé par une courte synthèse avant « prêt » (la voix est
chargée, la première vraie phrase n'attend pas). L'annulation (tts.cancel)
interrompt la synthèse en cours entre deux tranches. stdout est réservé au
protocole ; les logs vont sur stderr.

Sur le processeur, pas sur la puce graphique (MPS) : essayée le 2026-11-04,
elle recompile pour chaque nouvelle longueur de phrase (0,8 à 1,2 s avant le
premier son), donc plus lente en conversation, où chaque phrase est nouvelle.
"""
import base64
import json
import os
import sys
import threading
import queue

VOICE = os.environ.get("KOPILIA_KOKORO_VOICE", "ff_siwis")
LANG = os.environ.get("KOPILIA_KOKORO_LANG", "f")
SAMPLE_RATE = 24000

_cancelled = set()
_lock = threading.Lock()


def log(msg):
    sys.stderr.write(f"[kokoro] {msg}\n")
    sys.stderr.flush()


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def to_pcm16(audio):
    import numpy as np
    arr = np.asarray(audio, dtype="float32")
    arr = np.clip(arr, -1.0, 1.0)
    return (arr * 32767.0).astype("<i2").tobytes()


def main():
    try:
        from kokoro import KPipeline
    except Exception as e:  # dépendance absente
        emit({"type": "tts.error", "message": f"kokoro indisponible: {e}"})
        return

    pipeline = KPipeline(lang_code=LANG)
    for _ in pipeline("Bonjour.", voice=VOICE):  # chauffe
        pass
    emit({"type": "tts.ready", "voice": VOICE, "sampleRate": SAMPLE_RATE})
    log(f"prêt (voix={VOICE}, lang={LANG})")

    q = queue.Queue()

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                q.put(json.loads(line))
            except json.JSONDecodeError:
                pass
        q.put(None)

    threading.Thread(target=reader, daemon=True).start()

    while True:
        msg = q.get()
        if msg is None:
            break
        mtype = msg.get("type")
        if mtype == "tts.cancel":
            with _lock:
                _cancelled.add(msg.get("streamId"))
            continue
        if mtype != "tts.speak":
            continue
        stream_id = msg.get("streamId")
        text = msg.get("text", "")
        with _lock:
            _cancelled.discard(stream_id)
        emit({"type": "tts.start", "streamId": stream_id, "sampleRate": SAMPLE_RATE})
        seq = 0
        try:
            for _gs, _ps, audio in pipeline(text, voice=VOICE):
                with _lock:
                    if stream_id in _cancelled:
                        break
                pcm = to_pcm16(audio)
                emit({"type": "tts.chunk", "streamId": stream_id, "seq": seq, "pcmBase64": base64.b64encode(pcm).decode("ascii")})
                seq += 1
        except Exception as e:
            emit({"type": "tts.error", "streamId": stream_id, "message": str(e)})
            continue
        emit({"type": "tts.end", "streamId": stream_id})


if __name__ == "__main__":
    main()
