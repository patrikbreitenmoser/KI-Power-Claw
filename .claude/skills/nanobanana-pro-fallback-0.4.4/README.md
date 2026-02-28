# 🍌 Nano Banana Pro (Fallback Edition)

AI 圖片生成 Agent Skill，支援自動模型切換。

Fork of nano-banana-pro — same interface, added **automatic model fallback**.

## Features

- 🔄 **Auto Fallback** — `gemini-3.1-flash-image-preview` → `gemini-3-pro-image-preview` → `gemini-2.5-flash-image` → `gemini-2.0-flash-exp-image-generation`
- 🖼️ **Generate** — Text-to-image
- ✏️ **Edit** — Image-to-image, up to 14 input images
- 📐 **Auto Resolution** — Detects optimal resolution from input image size
- 📦 **Zero Config** — Just set `GEMINI_API_KEY` or `GOOGLE_API_KEY` and go

## Install

```bash
# Clone or copy into your project's .claude/skills/
git clone https://github.com/yazelin/nanobanana-pro.git
```

## Usage

```bash
# Generate
uv run scripts/generate_image.py --prompt "a cat in a garden" --filename "cat.png"

# Edit
uv run scripts/generate_image.py --prompt "make it sunset" --filename "out.png" -i input.png

# Multi-image composition
uv run scripts/generate_image.py --prompt "combine these" --filename "out.png" -i a.png -i b.png

# Resolution options: 1K (default), 2K, 4K
uv run scripts/generate_image.py --prompt "hi-res landscape" --filename "out.png" --resolution 2K
```

## Requirements

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) (auto-installs dependencies)
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable

## Configuration

| Env Variable | Description |
|---|---|
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini API key (required, either one) |
| `NANOBANANA_FALLBACK_MODELS` | Custom model chain, comma-separated |

## vs Original

| | nano-banana-pro | nanobanana-pro-fallback |
|---|---|---|
| Model | Fixed `gemini-3-pro-image-preview` | `gemini-3.1-flash` → `gemini-3-pro` → `gemini-2.5-flash` → `gemini-2.0-flash-exp` |
| Resolution detect | Manual only | Auto from input |

## License

MIT
