import argparse
import json
import math
import os
from pathlib import Path
import sys
from tempfile import gettempdir


ALLOWED_MODELS = {"tiny", "base", "small", "medium", "large-v3", "turbo"}
MAXIMUM_AUDIO_BYTES = 8 * 1024 * 1024


def parse_args():
    parser = argparse.ArgumentParser(description="Local JARVIS wearable speech transcription")
    parser.add_argument("--input")
    parser.add_argument("--language", default="ko-KR")
    parser.add_argument("--model", default="small", choices=sorted(ALLOWED_MODELS))
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--prefetch", action="store_true")
    parser.add_argument("--daemon", action="store_true")
    return parser.parse_args()


def normalized_language(value):
    language = str(value or "ko-KR").strip()
    return language.split("-", 1)[0].lower() or "ko"


def load_model(model_name, cache_dir):
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    from faster_whisper import WhisperModel

    cpu_threads = max(2, min(8, os.cpu_count() or 4))
    return WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        cpu_threads=cpu_threads,
        num_workers=1,
        download_root=str(cache_dir),
    )


def confidence_from_segments(segments):
    weighted_total = 0.0
    total_duration = 0.0
    for segment in segments:
        duration = max(0.01, float(segment.end) - float(segment.start))
        probability = math.exp(min(0.0, float(segment.avg_logprob)))
        weighted_total += probability * duration
        total_duration += duration
    if total_duration <= 0:
        return None
    return round(max(0.0, min(1.0, weighted_total / total_duration)), 4)


def transcribe(model, input_path, language):
    segments_iterator, _ = model.transcribe(
        str(input_path),
        language=normalized_language(language),
        beam_size=3,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False,
        temperature=0.0,
    )
    segments = list(segments_iterator)
    transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    transcript = " ".join(transcript.split())[:4000]
    if not transcript:
        raise ValueError("empty_transcript")
    return {
        "transcript": transcript,
        "confidence": confidence_from_segments(segments),
    }


def validated_audio_path(value, transient_only=False):
    input_path = Path(value).expanduser().resolve(strict=True)
    if transient_only:
        temporary_root = Path(gettempdir()).resolve()
        if input_path.parent != temporary_root or not input_path.name.startswith("jarvis-wearable-"):
            raise PermissionError("transient_audio_required")
    audio_bytes = input_path.stat().st_size
    if audio_bytes <= 0 or audio_bytes > MAXIMUM_AUDIO_BYTES:
        raise ValueError("invalid_audio_size")
    return input_path


def run_daemon(model):
    print(json.dumps({"type": "ready"}, ensure_ascii=True), flush=True)
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = str(request.get("requestId") or "")[:128]
            if not request_id:
                raise ValueError("request_id_required")
            input_path = validated_audio_path(request.get("inputPath"), transient_only=True)
            result = transcribe(model, input_path, request.get("language"))
            print(json.dumps({"requestId": request_id, **result}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({
                "requestId": request_id,
                "error": safe_daemon_error(error),
            }, ensure_ascii=True), flush=True)


def safe_daemon_error(error):
    if isinstance(error, ValueError) and str(error) == "empty_transcript":
        return "empty_transcript"
    if isinstance(error, ValueError) and str(error) == "invalid_audio_size":
        return "invalid_audio"
    if type(error).__name__ in {"InvalidDataError", "EOFError"}:
        return "audio_decode_failed"
    return "transcription_failed"


def main():
    args = parse_args()
    cache_dir = Path(args.cache_dir).expanduser().resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    if args.prefetch:
        load_model(args.model, cache_dir)
        print(json.dumps({
            "status": "ready",
            "model": args.model,
            "computeType": "int8",
            "rawAudioStored": False,
            "rawTranscriptLogged": False,
        }, ensure_ascii=True))
        return
    if args.daemon:
        run_daemon(load_model(args.model, cache_dir))
        return

    if not args.input:
        raise ValueError("input_required")
    input_path = validated_audio_path(args.input)
    model = load_model(args.model, cache_dir)
    print(json.dumps(transcribe(model, input_path, args.language), ensure_ascii=False))


if __name__ == "__main__":
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        main()
    except Exception as error:
        print(f"wearable_stt_failed:{type(error).__name__}", file=sys.stderr)
        raise SystemExit(2)
