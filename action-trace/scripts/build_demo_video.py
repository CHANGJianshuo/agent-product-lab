from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np


SAMPLE_RATE = 48_000


def srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d},{milliseconds:03d}"


def ass_timestamp(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    whole_seconds, centiseconds = divmod(remainder, 100)
    return f"{hours:d}:{minutes:02d}:{whole_seconds:02d}.{centiseconds:02d}"


def write_subtitles(captions: list[dict[str, object]], srt_path: Path, ass_path: Path) -> None:
    srt_blocks: list[str] = []
    ass_events: list[str] = []
    for index, caption in enumerate(captions, start=1):
        start = float(caption["start"])
        end = float(caption["end"])
        text = str(caption["text"])
        srt_blocks.append(
            f"{index}\n{srt_timestamp(start)} --> {srt_timestamp(end)}\n{text}\n"
        )
        safe_text = text.replace("{", "（").replace("}", "）").replace("\n", r"\N")
        ass_events.append(
            f"Dialogue: 0,{ass_timestamp(start)},{ass_timestamp(end)},Caption,,0,0,0,,{safe_text}"
        )
    srt_path.write_text("\n".join(srt_blocks), encoding="utf-8")

    header = """[Script Info]
Title: Converge 0.5 Chinese captions
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Microsoft YaHei,34,&H00F7FBF8,&H00FFFFFF,&H00142F2A,&H00142F2A,-1,0,0,0,100,100,0,0,3,8,0,2,150,150,27,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ass_path.write_text(header + "\n".join(ass_events) + "\n", encoding="utf-8")


def chord_frequencies() -> list[list[float]]:
    return [
        [130.81, 164.81, 196.00, 246.94, 293.66],  # Cmaj9
        [110.00, 130.81, 164.81, 196.00, 246.94],  # Am9
        [87.31, 130.81, 164.81, 220.00, 261.63],   # Fmaj7
        [98.00, 146.83, 196.00, 220.00, 293.66],   # G6sus2
    ]


def synthesize_ambient_music(duration: float, output_path: Path) -> None:
    """Create a deterministic, original ambient pad with a sparse bell melody."""

    frame_count = math.ceil(duration * SAMPLE_RATE)
    audio = np.zeros((frame_count, 2), dtype=np.float32)
    progression = chord_frequencies()
    step_seconds = 7.0
    chord_seconds = 10.5

    for chord_index, start_seconds in enumerate(np.arange(-3.5, duration, step_seconds)):
        start_frame = max(0, round(start_seconds * SAMPLE_RATE))
        end_frame = min(frame_count, round((start_seconds + chord_seconds) * SAMPLE_RATE))
        if end_frame <= start_frame:
            continue
        local_time = np.arange(start_frame, end_frame, dtype=np.float32) / SAMPLE_RATE - start_seconds
        phase = np.clip(local_time / chord_seconds, 0.0, 1.0)
        envelope = np.sin(np.pi * phase) ** 1.35
        slow_breath = 0.91 + 0.09 * np.sin(2 * np.pi * (0.055 + chord_index * 0.001) * local_time)
        chord = progression[chord_index % len(progression)]
        left = np.zeros_like(local_time)
        right = np.zeros_like(local_time)
        for note_index, frequency in enumerate(chord):
            weight = 1.0 / (1.0 + note_index * 0.34)
            phase_offset = note_index * 0.43
            left += weight * (
                np.sin(2 * np.pi * frequency * 0.9992 * local_time + phase_offset)
                + 0.18 * np.sin(2 * np.pi * frequency * 1.9984 * local_time + phase_offset / 2)
            )
            right += weight * (
                np.sin(2 * np.pi * frequency * 1.0008 * local_time + phase_offset + 0.18)
                + 0.18 * np.sin(2 * np.pi * frequency * 2.0016 * local_time + phase_offset / 2)
            )
        audio[start_frame:end_frame, 0] += left * envelope * slow_breath * 0.026
        audio[start_frame:end_frame, 1] += right * envelope * slow_breath * 0.026

    melody = [523.25, 659.25, 783.99, 659.25, 440.00, 523.25, 659.25, 587.33]
    for note_index, start_seconds in enumerate(np.arange(3.0, duration - 1.0, 4.2)):
        start_frame = round(start_seconds * SAMPLE_RATE)
        end_frame = min(frame_count, start_frame + round(3.8 * SAMPLE_RATE))
        local_time = np.arange(end_frame - start_frame, dtype=np.float32) / SAMPLE_RATE
        attack = 1.0 - np.exp(-local_time * 9.0)
        envelope = attack * np.exp(-local_time * 0.92)
        frequency = melody[note_index % len(melody)]
        bell = (
            np.sin(2 * np.pi * frequency * local_time)
            + 0.28 * np.sin(2 * np.pi * frequency * 2.01 * local_time + 0.4)
            + 0.10 * np.sin(2 * np.pi * frequency * 3.99 * local_time + 0.9)
        ) * envelope * 0.025
        pan = 0.30 + 0.40 * ((note_index % 4) / 3)
        audio[start_frame:end_frame, 0] += bell * math.sqrt(1.0 - pan)
        audio[start_frame:end_frame, 1] += bell * math.sqrt(pan)

    audio = np.tanh(audio * 1.28)
    peak = float(np.max(np.abs(audio))) or 1.0
    audio *= 0.22 / peak
    fade_frames = min(round(3.2 * SAMPLE_RATE), frame_count // 2)
    fade = np.sin(np.linspace(0, np.pi / 2, fade_frames, dtype=np.float32)) ** 2
    audio[:fade_frames] *= fade[:, None]
    audio[-fade_frames:] *= fade[::-1, None]

    pcm = np.clip(audio * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(output_path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())


def build_video(raw_video: Path, music: Path, ass_path: Path, duration: float, output: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 ffmpeg")
    fade_out_start = max(0.0, duration - 0.8)
    video_filter = (
        "[0:v]trim=start=0:end={duration},setpts=PTS-STARTPTS,fps=30,"
        "scale=1728:972:flags=lanczos,pad=1920:1080:96:0:color=0x102b26,setsar=1,"
        "ass=filename='{ass}':fontsdir='/home/chang/.fonts',"
        "fade=t=in:st=0:d=0.35,fade=t=out:st={fade}:d=0.8[v];"
        "[1:a]atrim=start=0:end={duration},asetpts=PTS-STARTPTS,"
        "highpass=f=55,lowpass=f=5200,volume=0.88,"
        "afade=t=in:st=0:d=2.5,afade=t=out:st={audio_fade}:d=3.0[a]"
    ).format(
        duration=f"{duration:.3f}",
        ass=ass_path.resolve().as_posix().replace("'", r"\'"),
        fade=f"{fade_out_start:.3f}",
        audio_fade=f"{max(0.0, duration - 3.0):.3f}",
    )
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-i",
        str(raw_video),
        "-i",
        str(music),
        "-filter_complex",
        video_filter,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        f"{duration:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-profile:v",
        "high",
        "-level",
        "4.1",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        str(SAMPLE_RATE),
        "-movflags",
        "+faststart",
        "-metadata",
        "title=Converge 0.5 - 从讨论到行动闭环",
        "-metadata",
        "comment=Product demo with original generated ambient score",
        str(output),
    ]
    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="为 Converge 录屏添加字幕、配乐并输出 MP4")
    parser.add_argument(
        "--production-dir",
        type=Path,
        default=Path("artifacts/demo-production"),
    )
    args = parser.parse_args()
    production_dir = args.production_dir.resolve()
    timeline = json.loads((production_dir / "timeline.json").read_text(encoding="utf-8"))
    captions = timeline["captions"]
    duration = max(float(timeline["recorded_seconds"]) - 0.15, float(captions[-1]["end"]) + 5.0)

    srt_path = production_dir / "converge-v0.5-full-demo.zh-CN.srt"
    ass_path = production_dir / "converge-v0.5-full-demo.zh-CN.ass"
    music_path = production_dir / "ambient-original.wav"
    output_path = production_dir / "converge-v0.5-full-demo-zh.mp4"
    write_subtitles(captions, srt_path, ass_path)
    synthesize_ambient_music(duration, music_path)
    build_video(
        production_dir / "raw" / "converge-demo-browser.webm",
        music_path,
        ass_path,
        duration,
        output_path,
    )
    print(
        json.dumps(
            {
                "output": str(output_path),
                "subtitles": str(srt_path),
                "music": str(music_path),
                "duration_seconds": round(duration, 3),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
