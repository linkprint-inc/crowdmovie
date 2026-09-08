#!/usr/bin/env python3
"""CPU ASR for generated media. No planned dialogue is used as an ASR prompt.

Runtime: isolated venv, faster-whisper==1.2.1; preload the model before release.
Print one JSON result to stdout. Diagnostic logs belong on stderr.
"""
import argparse
import json
from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument('audio')
parser.add_argument('--model', default='/opt/crowdmovie-film-audio/models/small.en')
args = parser.parse_args()
model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=8)
segments, info = model.transcribe(
    args.audio, language='en', beam_size=5, word_timestamps=True,
    vad_filter=True, condition_on_previous_text=False,
)
result = []
uncertain = []
for segment in segments:
    words = [{'start': w.start, 'end': w.end, 'word': w.word, 'probability': w.probability} for w in (segment.words or [])]
    record = {'start': segment.start, 'end': segment.end, 'text': segment.text.strip(),
              'avgLogprob': segment.avg_logprob, 'noSpeechProbability': segment.no_speech_prob,
              'words': words}
    mean_probability = sum(w['probability'] for w in words) / max(1, len(words))
    if segment.no_speech_prob > 0.6 or segment.avg_logprob < -1.0 or mean_probability < 0.5:
        uncertain.append(record)
    elif record['text']:
        result.append(record)
print(json.dumps({'version': 'film-asr-v1', 'engine': 'faster-whisper-1.2.1',
                  'model': args.model, 'language': info.language,
                  'duration': info.duration, 'segments': result, 'uncertainSegments': uncertain}))
