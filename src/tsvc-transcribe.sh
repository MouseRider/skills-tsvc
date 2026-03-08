#!/usr/bin/env bash
# tsvc-transcribe.sh — Topic-aware audio transcription via OpenAI Whisper API
# Reads active topic's vocabulary and passes it as the prompt parameter
# for improved transcription accuracy.
#
# Usage: tsvc-transcribe.sh <audio_file_path>
# Output: Transcription text to stdout
#
# Called by OpenClaw as a CLI media entry for audio transcription.

set -euo pipefail

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
VOCAB_FILE="$WORKSPACE/tsvc/active-whisper-prompt.txt"
MEDIA_PATH="${1:-}"

if [ -z "$MEDIA_PATH" ]; then
  echo "Usage: tsvc-transcribe.sh <audio_file_path>" >&2
  exit 1
fi

if [ ! -f "$MEDIA_PATH" ]; then
  echo "ERROR: Audio file not found: $MEDIA_PATH" >&2
  exit 1
fi

# Read active topic vocabulary (empty string if file doesn't exist)
VOCAB=""
if [ -f "$VOCAB_FILE" ]; then
  VOCAB=$(cat "$VOCAB_FILE")
fi

# Build curl args
CURL_ARGS=(
  -s
  "https://api.openai.com/v1/audio/transcriptions"
  -H "Authorization: Bearer ${OPENAI_API_KEY}"
  -F "file=@${MEDIA_PATH}"
  -F "model=gpt-4o-mini-transcribe"
  -F "response_format=text"
)

# Only add prompt if vocabulary exists
if [ -n "$VOCAB" ]; then
  CURL_ARGS+=(-F "prompt=${VOCAB}")
fi

RESULT=$(curl "${CURL_ARGS[@]}" 2>/dev/null)

if [ -z "$RESULT" ]; then
  echo "ERROR: Transcription returned empty result" >&2
  exit 1
fi

echo "$RESULT"
