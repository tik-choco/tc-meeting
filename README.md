# TC Meeting

A browser app for recording long meetings, transcribing audio in segments, and creating meeting minutes.

## Features

- Record a microphone, or mix it with shared tab audio where supported.
- Import audio and video files and split them into transcription segments.
- Pause, resume, and continue recordings on an existing timeline.
- Transcribe through a compatible speech API or the shared AI Network configuration.
- Search and edit transcripts, listen to saved audio, and retry failed segments.
- Keep rolling live notes as segments are transcribed, and translate each segment into a chosen language.
- Proofread each segment in its own language with changes highlighted, and read the corrections aloud with the shared voice setting or a browser voice.
- Fast chunk mode (6–15 s) shows text and corrections within seconds during live recording.
- Generate meeting minutes with a configured text model.
- Download Markdown, plain text, subtitle files (SRT/VTT), or JSON; copy text to the clipboard.
- English, Japanese, Simplified Chinese, and Traditional Chinese interfaces; light and dark themes.

Meetings and audio are stored locally in the browser. Transcription, live notes, translation, proofreading, read-aloud, and summarization send the relevant content to the configured connection. Recording works before speech recognition is configured; saved segments can be processed later. Live notes can be enabled per meeting and rebuilt from the transcript. Translation can be enabled per meeting and included in exports. Export important meetings for a separate backup. Clearing browser data removes local meetings.

Microphone capture requires a secure context (HTTPS or localhost) and browser permission. Tab audio availability depends on the browser and sharing selection. Imported audio is limited to 512 MB; decoding long files also requires sufficient device memory.

## Development

The app uses Preact, TypeScript, Vite, and Vitest.

```sh
npm ci
npm run dev
npm run build
npm test
npm run preview
```

For a type check without a production build, run `npx tsc -b`. Run an individual test with `npx vitest run path/to/file.test.ts`.
