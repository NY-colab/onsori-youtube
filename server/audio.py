from __future__ import annotations

from pathlib import Path
import numpy as np
import av

SAMPLE_RATE = 16000
MAX_DURATION = 1200


def decode_audio(path: Path) -> np.ndarray:
    """Use PyAV's bundled FFmpeg; bound decoded samples, including compressed bombs."""
    chunks, total = [], 0
    try:
        with av.open(str(path), metadata_errors="ignore") as container:
            if not container.streams.audio:
                raise ValueError("파일에 오디오 트랙이 없습니다.")
            resampler = av.AudioResampler(format="fltp", layout="mono", rate=SAMPLE_RATE)
            for frame in container.decode(audio=0):
                for output in resampler.resample(frame):
                    data = output.to_ndarray().reshape(-1)
                    total += len(data)
                    if total > SAMPLE_RATE * MAX_DURATION:
                        raise ValueError("프로토타입은 한 번에 20분까지 분석합니다. 파일을 나누어 주세요.")
                    chunks.append(data.copy())
            for output in resampler.resample(None):
                chunks.append(output.to_ndarray().reshape(-1).copy())
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("오디오를 읽을 수 없습니다. WAV, MP3, M4A, MP4, WebM 파일을 확인하세요.") from exc
    if not chunks:
        raise ValueError("빈 오디오입니다.")
    audio = np.nan_to_num(np.concatenate(chunks).astype(np.float32))
    if len(audio) > SAMPLE_RATE * MAX_DURATION:
        raise ValueError("20분을 초과한 파일입니다.")
    if len(audio) < SAMPLE_RATE * .2:
        raise ValueError("0.2초 이상의 오디오가 필요합니다.")
    return np.clip(audio, -1, 1)


def dbfs(samples: np.ndarray) -> float:
    if not len(samples):
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(samples.astype(np.float64)))))
    return max(-120.0, 20 * np.log10(max(rms, 1e-6)))


def envelope(audio: np.ndarray, step=.05) -> tuple[np.ndarray, np.ndarray]:
    n = max(1, round(SAMPLE_RATE * step))
    levels = np.array([dbfs(audio[i:i+n]) for i in range(0, len(audio), n)])
    return np.arange(len(levels)) * step, levels


def reference_level(audio: np.ndarray) -> float:
    _, levels = envelope(audio)
    active = levels[levels > -60]
    return float(np.median(active)) if len(active) else -60.0


def volume_style(audio: np.ndarray, start: float, end: float, reference: float) -> dict:
    chunk = audio[max(0, int(start * SAMPLE_RATE)):max(0, int(end * SAMPLE_RATE))]
    level = dbfs(chunk)
    delta = float(np.clip(level - reference, -120, 120))
    # Fixed calibration for the whole clip: do not normalize every cue individually.
    scale = float(np.clip(1 + delta / 40, .75, 1.55))
    return {"dbfs": round(level, 2), "relative_db": round(delta, 2), "scale": round(scale, 3)}


def volume_profile(audio: np.ndarray, start: float, end: float, reference: float) -> list[dict]:
    """100 ms RMS follows accents inside a cue, with fast attack/slow release.

    This measures the mixed waveform, not a speaker's semantic or pitch stress.
    The reference is fixed for the entire recording, never normalized per cue.
    """
    points = []
    previous = None
    for time in np.arange(start, end - .0005, .1):
        chunk = audio[max(0, round(time * SAMPLE_RATE)):round(min(end, time + .1) * SAMPLE_RATE)]
        level = dbfs(chunk)
        target = float(np.clip(1 + (level - reference) / 32, .75, 1.55))
        # An accent changes size quickly; recovery takes about 300 ms.
        if previous is None:
            previous = target
        else:
            previous += (.85 if target > previous else .35) * (target - previous)
        points.append({"time": round(float(time), 3), "dbfs": round(level, 2), "scale": round(previous, 3)})
    if points and round(end, 3) > points[-1]["time"]:
        points.append({**points[-1], "time": round(end, 3)})
    return points


def active_bounds(audio: np.ndarray, start: float, end: float) -> tuple[float, float]:
    """Energy refinement inside a classification window, not claimed frame-level SED."""
    chunk = audio[int(start*SAMPLE_RATE):int(end*SAMPLE_RATE)]
    times, levels = envelope(chunk, .05)
    if not len(levels):
        return start, end
    threshold = max(-55, float(np.max(levels)) - 24)
    active = np.flatnonzero(levels > threshold)
    if not len(active):
        return start, end
    return max(start, start + times[active[0]] - .1), min(end, start + times[active[-1]] + .15)
