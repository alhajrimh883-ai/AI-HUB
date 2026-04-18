"""
Voice Server — Local speech-to-text (Whisper via pywhispercpp) and
text-to-speech (Piper) in a single Flask process. Mirrors the lifecycle
pattern of vlm_server.py but is far simpler: both models are small enough
to stay resident in RAM without a park/unload dance.

Endpoints:
  GET  /status                     → { state, whisper, piper, ... }
  POST /config                     → set whisper/piper paths and lazy-reload
  POST /transcribe                 → { audio_base64, language? } → { text }
  POST /speak                      → { text, speed? } → { audio_base64, sample_rate }
  POST /download-whisper           → { size: 'tiny'|'base'|'small'|'medium' }
  POST /download-piper             → { voice: 'en_US-amy-medium' } (+ quality, lang)
  GET  /list-downloadable          → known Whisper sizes + curated Piper voices

Auto-download targets live under ./models_voice/ (created on first download
if missing). Users can point at their own paths via POST /config.
"""
import sys, os, gc, base64, io, wave, json, traceback, hashlib
from pathlib import Path

# Force UTF-8 on stdout/stderr so log lines with Unicode characters
# (→, —, …, box-drawing runes, etc.) don't crash Windows' default cp1252
# console when Flask endpoints hit `print(...)`. `errors='replace'` is a
# belt-and-braces guard — if any single glyph still can't be encoded,
# we substitute it rather than blow up mid-download.
sys.stdout.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
sys.stderr.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)

from flask import Flask, request, jsonify

app = Flask(__name__)

# ── Paths ───────────────────────────────────────────────────────────────
HERE = Path(__file__).resolve().parent
MODELS_DIR = HERE / 'models_voice'
WHISPER_DIR = MODELS_DIR / 'whisper'
PIPER_DIR = MODELS_DIR / 'piper'

# ── State ──────────────────────────────────────────────────────────────
whisper_model = None
whisper_path = None
whisper_loaded_from = None

piper_voice = None  # piper.PiperVoice instance
piper_path = None
piper_loaded_from = None

# Kokoro-82M is our newer, more natural TTS option. Unlike Piper it ships as a
# pip-installable package (`kokoro`) and auto-downloads weights from HF on first
# use, so there's no explicit .onnx file to track. We keep a single KPipeline
# per language code + a cache of the last synthesized voice name for logging.
kokoro_pipeline = None
kokoro_lang = 'a'           # 'a' = American English (default), 'b' = British, etc.
kokoro_voice_name = 'af_heart'
# Active TTS engine: 'kokoro' (default) or 'piper'. /speak branches on this.
tts_engine = 'kokoro'

# ── Server-side recorder state ─────────────────────────────────────────
# We record directly in Python via sounddevice because the renderer-side
# getUserMedia path was crashing Electron on some Windows audio drivers.
# The recorder owns a single in-progress stream at a time; /record/stop
# flushes captured frames, transcribes them, and returns the text in one
# round trip so the UI doesn't need base64 audio transport.
import threading
_rec_lock = threading.Lock()
_rec_state = {'stream': None, 'frames': [], 'sr': 16000}

# ── Known downloadable assets ──────────────────────────────────────────
WHISPER_SIZES = {
    'tiny':   ('ggml-tiny.bin',   75_000_000),
    'base':   ('ggml-base.bin',  142_000_000),
    'small':  ('ggml-small.bin', 466_000_000),
    'medium': ('ggml-medium.bin', 1_530_000_000),
}
WHISPER_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

# A curated short-list; more voices can be fetched by passing a full voice id.
PIPER_VOICES = {
    'en_US-amy-medium':    ('en',  'en_US', 'amy',   'medium'),
    'en_US-ryan-medium':   ('en',  'en_US', 'ryan',  'medium'),
    'en_GB-alan-medium':   ('en',  'en_GB', 'alan',  'medium'),
    'en_US-lessac-medium': ('en',  'en_US', 'lessac','medium'),
}
PIPER_BASE_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/'

# Kokoro ships voices inline with the package via HF's hexgrad/Kokoro-82M repo;
# we just expose the known names so the UI can populate a dropdown. Names
# follow the {region}{gender}_{adj} pattern: af_ = American female, am_ =
# American male, bf_ = British female, bm_ = British male.
KOKORO_VOICES = {
    'af_heart':    ('a', 'American English — warm female (default)'),
    'af_bella':    ('a', 'American English — soft female'),
    'af_nicole':   ('a', 'American English — clear female'),
    'af_sarah':    ('a', 'American English — neutral female'),
    'am_adam':     ('a', 'American English — deep male'),
    'am_michael':  ('a', 'American English — warm male'),
    'bf_emma':     ('b', 'British English — warm female'),
    'bf_isabella': ('b', 'British English — soft female'),
    'bm_george':   ('b', 'British English — mature male'),
    'bm_lewis':    ('b', 'British English — young male'),
}


# ═══════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════

def _err(msg, code=400, exc=None):
    if exc is not None:
        traceback.print_exc()
    print(f'[Voice] ERROR: {msg}', flush=True)
    return jsonify({'error': msg}), code


def _wav_bytes_to_float32(wav_bytes):
    """Decode WAV bytes → mono 16kHz float32 numpy array (what whisper wants)."""
    import numpy as np
    bio = io.BytesIO(wav_bytes)
    with wave.open(bio, 'rb') as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        frames = w.readframes(w.getnframes())
    if sw == 2:
        pcm = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        pcm = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif sw == 1:
        pcm = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f'Unsupported sample width: {sw}')
    if ch > 1:
        pcm = pcm.reshape(-1, ch).mean(axis=1)
    if sr != 16000:
        # Linear resample — good enough for Whisper. Avoids pulling scipy/librosa.
        ratio = 16000 / sr
        new_len = int(len(pcm) * ratio)
        x_old = np.linspace(0, 1, len(pcm), endpoint=False)
        x_new = np.linspace(0, 1, new_len, endpoint=False)
        pcm = np.interp(x_new, x_old, pcm).astype(np.float32)
    return pcm


def _ensure_whisper():
    """Lazy-load the Whisper model; raise if no path is configured."""
    global whisper_model, whisper_loaded_from
    if whisper_model is not None and whisper_loaded_from == whisper_path:
        return
    if not whisper_path or not os.path.exists(whisper_path):
        raise RuntimeError(f'Whisper model not found at: {whisper_path or "(unset)"}')
    print(f'[Voice] Loading Whisper: {whisper_path}', flush=True)
    from pywhispercpp.model import Model
    whisper_model = Model(whisper_path, print_realtime=False, print_progress=False)
    whisper_loaded_from = whisper_path
    print('[Voice] Whisper ready', flush=True)


def _ensure_piper():
    """Lazy-load the Piper voice; raise if no path is configured."""
    global piper_voice, piper_loaded_from
    if piper_voice is not None and piper_loaded_from == piper_path:
        return
    if not piper_path or not os.path.exists(piper_path):
        raise RuntimeError(f'Piper voice not found at: {piper_path or "(unset)"}')
    print(f'[Voice] Loading Piper: {piper_path}', flush=True)
    from piper import PiperVoice
    piper_voice = PiperVoice.load(piper_path)
    piper_loaded_from = piper_path
    print('[Voice] Piper ready', flush=True)


def _ensure_kokoro():
    """Lazy-instantiate the Kokoro pipeline for the current language code.

    Kokoro auto-downloads weights from HuggingFace on first use (~330MB to the
    default HF cache dir under ~/.cache/huggingface/). We rebuild the pipeline
    only if the language code actually changed — different voices inside the
    same language share one pipeline. Voice selection happens at __call__ time.
    """
    global kokoro_pipeline
    if kokoro_pipeline is not None and getattr(kokoro_pipeline, '_voice_server_lang', None) == kokoro_lang:
        return
    print(f'[Voice] Loading Kokoro pipeline (lang={kokoro_lang})...', flush=True)
    try:
        from kokoro import KPipeline
    except ImportError as e:
        raise RuntimeError(
            'kokoro package is not installed. Click "Install Kokoro" in Settings, '
            'or run: pip install kokoro soundfile'
        ) from e
    kokoro_pipeline = KPipeline(lang_code=kokoro_lang)
    # Stash the lang on the instance so the early-exit check above can see it.
    setattr(kokoro_pipeline, '_voice_server_lang', kokoro_lang)
    print('[Voice] Kokoro ready', flush=True)


def _download_file(url, dest, on_progress=None):
    """Download a URL to `dest` with simple progress prints."""
    import requests
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.part')
    print(f'[Voice] Downloading {url} → {dest}', flush=True)
    with requests.get(url, stream=True, timeout=30) as r:
        r.raise_for_status()
        total = int(r.headers.get('Content-Length') or 0)
        got = 0
        last_pct = -1
        with open(tmp, 'wb') as f:
            for chunk in r.iter_content(chunk_size=1024 * 64):
                if not chunk:
                    continue
                f.write(chunk)
                got += len(chunk)
                if total:
                    pct = int(got * 100 / total)
                    if pct != last_pct and pct % 5 == 0:
                        print(f'[Voice]   …{pct}% ({got // 1_000_000}MB / {total // 1_000_000}MB)', flush=True)
                        last_pct = pct
                if on_progress:
                    on_progress(got, total)
    tmp.rename(dest)
    print(f'[Voice] Done: {dest} ({got // 1_000_000}MB)', flush=True)
    return str(dest)


# ═══════════════════════════════════════════════════════════════════════
# Routes — status + config
# ═══════════════════════════════════════════════════════════════════════

@app.route('/status', methods=['GET'])
def status():
    return jsonify({
        'state': 'ready',
        'engine': tts_engine,
        'whisper': {
            'path': whisper_path,
            'loaded': whisper_model is not None,
            'name': Path(whisper_path).name if whisper_path else None,
        },
        'piper': {
            'path': piper_path,
            'loaded': piper_voice is not None,
            'name': Path(piper_path).name if piper_path else None,
        },
        'kokoro': {
            'loaded': kokoro_pipeline is not None,
            'voice': kokoro_voice_name,
            'lang': kokoro_lang,
            'available': _kokoro_available(),
        },
    })


def _kokoro_available():
    """Cheap probe so the UI can warn the user if `pip install kokoro` hasn't
    run yet. We don't cache the result — the venv can gain the package between
    calls if the user just clicked Install."""
    try:
        import importlib
        importlib.import_module('kokoro')
        return True
    except ImportError:
        return False


@app.route('/config', methods=['POST'])
def config():
    """Set paths + TTS engine. Lazy-reload happens on the next transcribe/speak call."""
    global whisper_path, piper_path, whisper_model, piper_voice
    global whisper_loaded_from, piper_loaded_from
    global tts_engine, kokoro_voice_name, kokoro_lang, kokoro_pipeline
    try:
        data = request.json or {}
        wp = data.get('whisper_path')
        pp = data.get('piper_path')
        eng = data.get('engine')                 # 'kokoro' | 'piper' | None
        kv = data.get('kokoro_voice')            # e.g. 'af_heart' | None
        if wp is not None and wp != whisper_path:
            whisper_path = wp or None
            # Drop any old model — next call will reload from the new path.
            whisper_model = None
            whisper_loaded_from = None
            gc.collect()
        if pp is not None and pp != piper_path:
            piper_path = pp or None
            piper_voice = None
            piper_loaded_from = None
            gc.collect()
        if eng in ('kokoro', 'piper') and eng != tts_engine:
            tts_engine = eng
            print(f'[Voice] TTS engine switched to: {tts_engine}', flush=True)
        if kv:
            kokoro_voice_name = kv
            # If the new voice implies a different language, rebuild the
            # pipeline on the next /speak call.
            new_lang = KOKORO_VOICES.get(kv, (None,))[0]
            if new_lang and new_lang != kokoro_lang:
                kokoro_lang = new_lang
                kokoro_pipeline = None
                gc.collect()
        return jsonify({
            'ok': True,
            'whisper_path': whisper_path,
            'piper_path': piper_path,
            'engine': tts_engine,
            'kokoro_voice': kokoro_voice_name,
            'kokoro_lang': kokoro_lang,
        })
    except Exception as e:
        return _err(str(e), 500, exc=e)


# ═══════════════════════════════════════════════════════════════════════
# Routes — STT + TTS
# ═══════════════════════════════════════════════════════════════════════

@app.route('/transcribe', methods=['POST'])
def transcribe():
    try:
        data = request.json or {}
        audio_b64 = data.get('audio_base64')
        language = data.get('language')  # None → auto-detect
        if not audio_b64:
            return _err('audio_base64 is required')
        _ensure_whisper()
        wav_bytes = base64.b64decode(audio_b64)
        pcm = _wav_bytes_to_float32(wav_bytes)
        kwargs = {}
        if language:
            kwargs['language'] = language
        segments = whisper_model.transcribe(pcm, **kwargs)
        text = ' '.join(s.text.strip() for s in segments).strip()
        print(f'[Voice] Transcribed {len(pcm) / 16000:.1f}s -> {len(text)} chars', flush=True)
        return jsonify({'text': text})
    except Exception as e:
        return _err(str(e), 500, exc=e)


# =======================================================================
# Routes -- server-side recording (sounddevice-backed)
# =======================================================================
# These endpoints own the microphone directly via PortAudio/sounddevice,
# bypassing the renderer's WebRTC/MediaRecorder stack (which was hard-crashing
# Electron on some Windows audio drivers). /record/stop transcribes inline so
# the UI only needs one round trip to get text back.

@app.route('/record/start', methods=['POST'])
def record_start():
    try:
        try:
            import sounddevice as sd
        except Exception as e:
            return _err(f'sounddevice unavailable: {e}', 500)

        sr = 16000  # Whisper's native rate; capture at rate = no resample later
        with _rec_lock:
            if _rec_state['stream'] is not None:
                return _err('already recording -- stop the current session first')
            _rec_state['frames'] = []
            _rec_state['sr'] = sr
            frames_buf = _rec_state['frames']

            def cb(indata, frame_count, time_info, status):
                if status:
                    print(f'[Voice] Recorder status: {status}', flush=True)
                # sounddevice reuses the buffer on the next callback -- copy it.
                frames_buf.append(indata.copy())

            stream = sd.InputStream(
                samplerate=sr, channels=1, dtype='float32',
                blocksize=0, callback=cb,
            )
            stream.start()
            _rec_state['stream'] = stream
        print('[Voice] Recording started', flush=True)
        return jsonify({'ok': True, 'sample_rate': sr})
    except Exception as e:
        # Make sure we don't leak a half-open stream.
        with _rec_lock:
            s = _rec_state.get('stream')
            if s is not None:
                try: s.stop()
                except Exception: pass
                try: s.close()
                except Exception: pass
            _rec_state['stream'] = None
            _rec_state['frames'] = []
        return _err(str(e), 500, exc=e)


@app.route('/record/stop', methods=['POST'])
def record_stop():
    try:
        data = request.json or {}
        language = data.get('language')           # None -> auto-detect
        transcribe_now = data.get('transcribe', True)

        with _rec_lock:
            stream = _rec_state['stream']
            frames = _rec_state['frames']
            sr = _rec_state['sr']
            _rec_state['stream'] = None
            _rec_state['frames'] = []

        if stream is None:
            return jsonify({'ok': True, 'text': '', 'duration_sec': 0, 'recorded': False})

        try: stream.stop()
        except Exception: pass
        try: stream.close()
        except Exception: pass

        import numpy as np
        if not frames:
            return jsonify({'ok': True, 'text': '', 'duration_sec': 0, 'recorded': True})
        pcm = np.concatenate(frames).flatten().astype(np.float32)
        dur = float(len(pcm)) / sr
        print(f'[Voice] Recording stopped: {dur:.2f}s', flush=True)

        text = ''
        if transcribe_now:
            _ensure_whisper()
            kwargs = {}
            if language:
                kwargs['language'] = language
            # pywhispercpp accepts float32 at 16 kHz directly -- no resample.
            segments = whisper_model.transcribe(pcm, **kwargs)
            text = ' '.join(s.text.strip() for s in segments).strip()
            print(f'[Voice] Transcribed {dur:.1f}s -> {len(text)} chars', flush=True)

        return jsonify({
            'ok': True, 'text': text, 'duration_sec': dur,
            'recorded': True, 'sample_rate': sr,
        })
    except Exception as e:
        return _err(str(e), 500, exc=e)


@app.route('/record/cancel', methods=['POST'])
def record_cancel():
    """Abort an in-flight recording without transcribing."""
    try:
        with _rec_lock:
            stream = _rec_state['stream']
            _rec_state['stream'] = None
            _rec_state['frames'] = []
        if stream is not None:
            try: stream.stop()
            except Exception: pass
            try: stream.close()
            except Exception: pass
        return jsonify({'ok': True})
    except Exception as e:
        return _err(str(e), 500, exc=e)


def _synthesize_piper(text):
    """Run text through Piper; return (wav_bytes, sample_rate).

    piper-tts 1.2+ changed the API: `synthesize(text, wav_file)` no longer
    auto-populates the wave writer. It now returns an iterable of
    `AudioChunk` objects that carry sample_rate/sample_width/sample_channels
    plus int16 PCM bytes. We try APIs in order of preference so this keeps
    working across piper versions:
      1. `synthesize_wav(text, wf)` — single-call helper in newer builds
      2. iterate `synthesize(text)` chunks and populate the writer ourselves
      3. legacy `synthesize(text, wf)` — old auto-populate behaviour
    """
    _ensure_piper()
    bio = io.BytesIO()
    sr = 22050  # Piper default; overwritten if a chunk tells us otherwise
    with wave.open(bio, 'wb') as wf:
        if hasattr(piper_voice, 'synthesize_wav'):
            piper_voice.synthesize_wav(text, wf)
        else:
            produced_frames = False
            header_set = False
            result = piper_voice.synthesize(text)
            if result is None:
                piper_voice.synthesize(text, wf)
                produced_frames = True
                header_set = True
            else:
                for chunk in result:
                    if not header_set:
                        wf.setnchannels(getattr(chunk, 'sample_channels', 1))
                        wf.setsampwidth(getattr(chunk, 'sample_width', 2))
                        sr = getattr(chunk, 'sample_rate', sr)
                        wf.setframerate(sr)
                        header_set = True
                    pcm = getattr(chunk, 'audio_int16_bytes', None) or getattr(chunk, 'audio', b'')
                    if pcm:
                        wf.writeframes(pcm)
                        produced_frames = True
            if not header_set:
                wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sr)
            if not produced_frames:
                raise RuntimeError('Piper produced no audio for the given text')
    wav_bytes = bio.getvalue()
    bio.seek(0)
    with wave.open(bio, 'rb') as wf_read:
        sr = wf_read.getframerate()
    return wav_bytes, sr


def _synthesize_kokoro(text):
    """Run text through Kokoro; return (wav_bytes, sample_rate).

    KPipeline(text, voice=...) yields (graphemes, phonemes, audio) tuples
    where `audio` is a float32 numpy array in [-1, 1] at 24 kHz. We
    concatenate across tuples (Kokoro chunks long input by sentence) then
    encode as 16-bit PCM WAV — the same format Piper emits, so the
    downstream audio-tag player doesn't need to care which engine ran.
    """
    _ensure_kokoro()
    import numpy as np
    sr = 24000  # Kokoro's fixed output sample rate
    chunks = []
    for _graphemes, _phonemes, audio in kokoro_pipeline(text, voice=kokoro_voice_name):
        if audio is None:
            continue
        # `audio` may be a torch tensor in some kokoro versions — coerce.
        if hasattr(audio, 'cpu') and hasattr(audio, 'numpy'):
            audio = audio.cpu().numpy()
        chunks.append(np.asarray(audio, dtype=np.float32).flatten())
    if not chunks:
        raise RuntimeError('Kokoro produced no audio for the given text')
    pcm_f32 = np.concatenate(chunks)
    # Clip and convert to int16 — matches the WAV encoding Piper uses, so the
    # renderer's <audio> element can play either engine's output the same way.
    pcm_f32 = np.clip(pcm_f32, -1.0, 1.0)
    pcm_i16 = (pcm_f32 * 32767.0).astype(np.int16)
    bio = io.BytesIO()
    with wave.open(bio, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sr)
        wf.writeframes(pcm_i16.tobytes())
    return bio.getvalue(), sr


@app.route('/speak', methods=['POST'])
def speak():
    try:
        data = request.json or {}
        text = (data.get('text') or '').strip()
        if not text:
            return _err('text is required')

        if tts_engine == 'kokoro':
            wav_bytes, sr = _synthesize_kokoro(text)
        else:
            wav_bytes, sr = _synthesize_piper(text)

        print(f'[Voice] Spoke {len(text)} chars via {tts_engine} -> {len(wav_bytes) / 1000:.1f}KB @ {sr}Hz', flush=True)
        return jsonify({
            'audio_base64': base64.b64encode(wav_bytes).decode('ascii'),
            'sample_rate': sr,
            'engine': tts_engine,
        })
    except Exception as e:
        return _err(str(e), 500, exc=e)


# ═══════════════════════════════════════════════════════════════════════
# Routes — download helpers
# ═══════════════════════════════════════════════════════════════════════

@app.route('/list-downloadable', methods=['GET'])
def list_downloadable():
    return jsonify({
        'whisper_sizes': {k: {'filename': v[0], 'approx_size': v[1]} for k, v in WHISPER_SIZES.items()},
        'piper_voices': list(PIPER_VOICES.keys()),
        'kokoro_voices': {k: {'lang': v[0], 'description': v[1]} for k, v in KOKORO_VOICES.items()},
    })


@app.route('/download-kokoro', methods=['POST'])
def download_kokoro():
    """Kokoro has no discrete download step — weights live in the HF cache and
    are fetched by KPipeline on first construction. We trigger that here so
    the user gets a clean "downloaded" status instead of waiting for the
    first /speak call to block for 30+ seconds on a slow connection.

    Returns `{ok, cached}` — `cached=True` means the pipeline was already
    loaded in this process (the HF cache may or may not have been populated
    on disk; we can't cheaply tell from here).
    """
    try:
        global kokoro_pipeline, kokoro_lang
        data = request.json or {}
        voice = data.get('voice') or kokoro_voice_name
        lang = KOKORO_VOICES.get(voice, (kokoro_lang,))[0]
        was_loaded = kokoro_pipeline is not None
        if lang != kokoro_lang:
            kokoro_lang = lang
            kokoro_pipeline = None
        _ensure_kokoro()
        # Do a tiny throwaway synthesis to force voice weights into the cache
        # (Kokoro lazy-loads per-voice tensors on first use).
        try:
            for _ in kokoro_pipeline('test', voice=voice):
                break
        except Exception as synth_err:
            # Non-fatal — the pipeline is loaded; synthesis just didn't complete
            # (e.g. espeak-ng missing on Windows OOD words).
            print(f'[Voice] Kokoro warmup synth warning: {synth_err}', flush=True)
        return jsonify({'ok': True, 'voice': voice, 'lang': lang, 'cached': was_loaded})
    except Exception as e:
        return _err(str(e), 500, exc=e)


@app.route('/download-whisper', methods=['POST'])
def download_whisper():
    try:
        data = request.json or {}
        size = data.get('size', 'base')
        if size not in WHISPER_SIZES:
            return _err(f'Unknown Whisper size: {size}. Choose from {list(WHISPER_SIZES.keys())}')
        filename, _approx = WHISPER_SIZES[size]
        dest = WHISPER_DIR / filename
        if dest.exists():
            return jsonify({'ok': True, 'path': str(dest), 'cached': True})
        _download_file(WHISPER_BASE_URL + filename, dest)
        return jsonify({'ok': True, 'path': str(dest), 'cached': False})
    except Exception as e:
        return _err(str(e), 500, exc=e)


@app.route('/download-piper', methods=['POST'])
def download_piper():
    try:
        data = request.json or {}
        voice = data.get('voice', 'en_US-amy-medium')
        if voice not in PIPER_VOICES:
            return _err(f'Unknown Piper voice: {voice}. Known: {list(PIPER_VOICES.keys())}')
        lang, locale, name, quality = PIPER_VOICES[voice]
        # Piper HF layout: <lang>/<locale>/<name>/<quality>/<voice>.onnx(.json)
        base = f'{lang}/{locale}/{name}/{quality}/{voice}'
        onnx_url = PIPER_BASE_URL + base + '.onnx'
        json_url = PIPER_BASE_URL + base + '.onnx.json'
        onnx_dest = PIPER_DIR / f'{voice}.onnx'
        json_dest = PIPER_DIR / f'{voice}.onnx.json'
        cached = onnx_dest.exists() and json_dest.exists()
        if not cached:
            _download_file(onnx_url, onnx_dest)
            _download_file(json_url, json_dest)
        return jsonify({'ok': True, 'path': str(onnx_dest), 'cached': cached})
    except Exception as e:
        return _err(str(e), 500, exc=e)


# ═══════════════════════════════════════════════════════════════════════
# Entry
# ═══════════════════════════════════════════════════════════════════════

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5124)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--whisper', default=None, help='Path to a Whisper ggml .bin')
    parser.add_argument('--piper', default=None, help='Path to a Piper .onnx voice')
    parser.add_argument('--engine', default=None, choices=['kokoro', 'piper'],
                        help='TTS engine (default: kokoro)')
    parser.add_argument('--kokoro-voice', default=None, help='Kokoro voice name, e.g. af_heart')
    args = parser.parse_args()

    global whisper_path, piper_path, tts_engine, kokoro_voice_name, kokoro_lang
    if args.whisper:
        whisper_path = args.whisper
    if args.piper:
        piper_path = args.piper
    if args.engine:
        tts_engine = args.engine
    if args.kokoro_voice:
        kokoro_voice_name = args.kokoro_voice
        kokoro_lang = KOKORO_VOICES.get(args.kokoro_voice, (kokoro_lang,))[0]

    print(f'[Voice] Starting server on {args.host}:{args.port}', flush=True)
    print(f'[Voice] whisper_path={whisper_path}', flush=True)
    print(f'[Voice] piper_path={piper_path}', flush=True)
    print(f'[Voice] engine={tts_engine}, kokoro_voice={kokoro_voice_name}', flush=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    app.run(host=args.host, port=args.port, threaded=True, use_reloader=False)


if __name__ == '__main__':
    main()
