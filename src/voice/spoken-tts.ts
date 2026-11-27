import type { APIConnectOptions } from '@livekit/agents';
import { TTS } from '@livekit/agents-plugin-deepgram';
import { toSpeakable } from './speech-text.js';

// The adapter retains its original sentence for timed captions and committed history.
// Only the provider request receives the wording intended for audio.
export class SpokenTTS extends TTS {
  override synthesize(text: string, options?: APIConnectOptions, signal?: AbortSignal): ReturnType<TTS['synthesize']> {
    return super.synthesize(toSpeakable(text), options, signal);
  }
}
