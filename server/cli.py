import argparse
from pathlib import Path
import threading
from .pipeline import analyze
from .schema import AnalysisOptions, subtitle_text


def main():
    parser = argparse.ArgumentParser(description="OnSori local audio -> captions (no cloud API)")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--language", default="ko")
    parser.add_argument("--model", default="base")
    parser.add_argument("--no-events", action="store_true")
    parser.add_argument("--no-speech", action="store_true")
    parser.add_argument("--captions", action="store_true")
    parser.add_argument("--video-id")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    options = AnalysisOptions(language=args.language, whisper_model=args.model, event_detection=not args.no_events,
                              transcribe=not args.no_speech, audio_captioning=args.captions, video_id=args.video_id,
                              title=args.input.stem)
    document = analyze(args.input, options, args.output, lambda p,m: print(f"{p:.0%} {m}", flush=True), threading.Event())
    for fmt in ("srt", "vtt"):
        (args.output / f"captions.{fmt}").write_text(subtitle_text(document, fmt), encoding="utf-8")
    print(args.output / "result.json")


if __name__ == "__main__":
    main()
