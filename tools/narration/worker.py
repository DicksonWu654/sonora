"""Persistent local Kokoro worker. stdout is JSON-lines; diagnostics use stderr."""
import os, sys, json, re, time, hashlib, unicodedata, struct, math
from pathlib import Path

HOME = Path(os.environ.get('NARRATION_HOME', Path.home() / '.cache' / 'sonora'))
MODEL = HOME / 'narration-model'
CACHE = HOME / 'narration-audio'
REVISION = 'f3ff3571791e39611d31c381e3a41a3af07b4987'
VERSION = 'kokoro-0.9.4-books-2'
VOICES = ('af_heart', 'af_bella')
# The installed model and language assets must suffice; ordinary listening never downloads.
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
protocol = sys.stdout
sys.stdout = sys.stderr
import espeakng_loader
os.environ['PHONEMIZER_ESPEAK_LIBRARY'] = espeakng_loader.get_library_path()
os.environ['ESPEAK_DATA_PATH'] = espeakng_loader.get_data_path()
import torch
import soundfile as sf
import numpy as np
from kokoro import KModel, KPipeline
import spacy
if not spacy.util.is_package('en_core_web_sm'):
    raise RuntimeError('Local English language assets missing. Run npm run narration:setup.')
torch.set_num_threads(max(1, min(4, int(os.environ.get('NARRATION_THREADS', '4')))))
device = os.environ.get('NARRATION_DEVICE', 'cpu')
if device not in ('cpu', 'cuda'):
    raise ValueError('NARRATION_DEVICE must be cpu or cuda.')
if device == 'cuda' and not torch.cuda.is_available():
    raise RuntimeError('CUDA was requested but is unavailable in this runtime.')
model = KModel(repo_id='hexgrad/Kokoro-82M', config=str(MODEL / 'config.json'), model=str(MODEL / 'kokoro-v1_0.pth')).to(device).eval()
pipeline = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M', model=model)
for voice in VOICES:
    pipeline.voices[voice] = torch.load(MODEL / 'voices' / (voice + '.pt'), map_location='cpu', weights_only=True)
CACHE.mkdir(parents=True, exist_ok=True)

def emit(value):
    protocol.write(json.dumps(value, ensure_ascii=True) + '\n')
    protocol.flush()

def utf16_len(text):
    return len(text.encode('utf-16-le')) // 2

def canonical(text):
    out, positions = '', []
    for i, c in enumerate(text):
        normalized = unicodedata.normalize('NFKC', c).translate(str.maketrans({'’':"'", '‘':"'", '“':'"', '”':'"', '–':'-', '—':'-'}))
        out += normalized
        positions.extend([i] * len(normalized))
    return out, positions

# Replace pronunciation only: displayed text and source offsets stay unchanged.
PRONUNCIATIONS = {'nm':'nanometers', 'µm':'micrometers', 'μm':'micrometers', 'GHz':'gigahertz', 'MHz':'megahertz', 'kHz':'kilohertz', 'SiO₂':'silicon dioxide', 'SiO2':'silicon dioxide'}
pronunciation_cache = {}
def prepare_tokens(text):
    _, tokens = pipeline.g2p(text)
    normalized, positions = canonical(text)
    cursor = 0
    locations = {}
    for token in tokens:
        key, _ = canonical(token.text)
        at = normalized.find(key, cursor) if key else -1
        if at >= 0:
            begin, end = positions[at], positions[at + len(key) - 1] + 1
            locations[id(token)] = (utf16_len(text[:begin]), utf16_len(text[begin:end]))
            cursor = at + len(key)
        # G2P may normalize punctuation or abbreviations. Missing highlight
        # offsets must not prevent synthesis of the original tokens.
        spoken = PRONUNCIATIONS.get(token.text)
        if not spoken and re.fullmatch(r'\d+(?:\.\d+)?[–−]\d+(?:\.\d+)?%?', token.text):
            spoken = re.sub('[–−]', ' to ', token.text)
        if spoken:
            if spoken not in pronunciation_cache:
                pronunciation_cache[spoken] = pipeline.g2p(spoken)[0]
            token.phonemes = pronunciation_cache[spoken]
        if token.phonemes and len(token.phonemes) > 480:
            raise ValueError('A word is too long to narrate safely. Choose a shorter passage.')
    return tokens, locations

def speech_batches(tokens):
    # Numeric/unit expansion can overflow an upstream chunk. Keep the original
    # tokens (and their source offsets), but give such passages a smaller budget.
    if all(len(phonemes) <= 510 for _, phonemes, _ in pipeline.en_tokenize(tokens)):
        return [tokens]
    batches, current, size = [], [], 0
    for token in tokens:
        cost = len(token.phonemes or '') + 1
        if current and size + cost > 400:
            batches.append(current)
            current, size = [], 0
        current.append(token)
        size += cost
    if current:
        batches.append(current)
    if any(len(phonemes) > 510 for batch in batches for _, phonemes, _ in pipeline.en_tokenize(batch)):
        raise ValueError('Passage exceeds the local model chunk limit.')
    return batches

def read_cache(key, text, voice):
    """A damaged/interrupted cache entry is a miss, never a permanent error."""
    try:
        audio_file = CACHE / (key + '.wav')
        size = audio_file.stat().st_size
        with audio_file.open('rb') as file:
            header = file.read(44)
        if len(header) != 44 or header[:4] != b'RIFF' or header[8:16] != b'WAVEfmt ' or header[36:40] != b'data':
            return None
        if size <= 44 or struct.unpack_from('<I', header, 4)[0] != size - 8 or struct.unpack_from('<I', header, 40)[0] != size - 44:
            return None
        if struct.unpack_from('<HHI', header, 20) != (1, 1, 24000) or struct.unpack_from('<H', header, 34)[0] != 16:
            return None
        data = json.loads((CACHE / (key + '.json')).read_text())
        duration = (size - 44) / 48000
        if data.get('voice') != voice or data.get('audioUrl') != '/api/narration/audio/' + key + '.wav' or not isinstance(data.get('duration'), (int, float)) or not math.isfinite(data['duration']) or abs(data['duration'] - duration) > .001:
            return None
        words = data.get('words')
        if not isinstance(words, list):
            return None
        last = -1
        for word in words:
            start, end, offset, length = (word.get(field) for field in ('start', 'end', 'textOffset', 'length'))
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (start, end)) or not 0 <= start < end <= duration or start < last:
                return None
            if type(offset) is not int or type(length) is not int or offset < 0 or length <= 0 or offset + length > utf16_len(text):
                return None
            last = start
        data['cached'] = True
        return data
    except (OSError, ValueError, TypeError, AttributeError, struct.error):
        return None

def render(text, voice):
    if not isinstance(text, str) or not text.strip() or len(text) > 4000 or '\x00' in text:
        raise ValueError('Provide between 1 and 4000 characters of lesson text.')
    if voice not in VOICES:
        raise ValueError('Unknown local voice.')
    key = hashlib.sha256(json.dumps([VERSION, REVISION, voice, text], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    metadata_file, audio_file = CACHE / (key + '.json'), CACHE / (key + '.wav')
    cached = read_cache(key, text, voice)
    if cached is not None:
        return cached
    began = time.monotonic()
    tokens, locations = prepare_tokens(text)
    batches = speech_batches(tokens)
    words, chunks, offset = [], [], 0.0
    with torch.inference_mode():
        for result in (result for batch in batches for result in pipeline.generate_from_tokens(batch, voice=voice, speed=1)):
            if len(result.phonemes) > 510:
                raise ValueError('Passage exceeds the local model chunk limit.')
            audio = result.audio.detach().cpu().numpy()
            duration = len(audio) / 24000
            for token in result.tokens or []:
                if token.start_ts is None or token.end_ts is None or not any(c.isalnum() for c in token.text):
                    continue
                location = locations.get(id(token))
                if location is None:
                    continue
                start = offset + max(0, min(duration, float(token.start_ts)))
                end = offset + max(0, min(duration, float(token.end_ts)))
                if end > start:
                    words.append({'start':round(start, 5), 'end':round(end, 5), 'textOffset':location[0], 'length':location[1]})
            chunks.append(audio)
            offset += duration
    if not chunks:
        raise ValueError('No readable words were found in this passage.')
    audio = np.concatenate(chunks)
    result = {'audioUrl':'/api/narration/audio/' + key + '.wav', 'words':words, 'duration':len(audio)/24000, 'voice':voice, 'cached':False, 'generationSeconds':round(time.monotonic()-began, 3), 'engine':'Kokoro 0.9.4', 'timing':'model-derived'}
    temporary_audio = CACHE / (key + '.wav.tmp')
    temporary_metadata = CACHE / (key + '.json.tmp')
    sf.write(temporary_audio, audio, 24000, format='WAV', subtype='PCM_16')
    temporary_audio.replace(audio_file)
    temporary_metadata.write_text(json.dumps(result))
    temporary_metadata.replace(metadata_file)
    return result

emit({'event':'ready'})
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        result = render(request.get('text'), request.get('voice', 'af_heart'))
        emit({'id':request['id'], 'result':result})
    except Exception as exc:
        print(f'Narration error: {type(exc).__name__}: {exc}', file=sys.stderr)
        emit({'id':request.get('id'), 'error':str(exc) if isinstance(exc, ValueError) else 'Local voice could not render this passage.'})
