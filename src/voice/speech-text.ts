// Makes reply text safe to SPEAK. The bot includes real links / emails / phone numbers in its
// replies so they appear on screen (as a tappable "Open the link" button), but text-to-speech must
// never read them out character by character ("h t t p s colon…", "0 3 3 2 6…").
//
// Applied only to the TTS input (session `ttsTextTransforms`); captions keep the original text.
import { ReadableStream, TransformStream } from 'node:stream/web';

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
// A link never ends in sentence punctuation, so "…/pricing." keeps its full stop for the sentence.
const URL_WITH_SCHEME = /\b(?:https?:\/\/|www\.)\S*[^\s.,;:!?)\]]/gi;
const BARE_DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|co|dev|app|uk|us|ca|au|in|pk|ae)(?:\/\S*[^\s.,;:!?)\]])?\/?/gi;
const NUMBER_RUN = /\+?\d[\d\s().-]{5,}\d/g;
const MIN_PHONE_DIGITS = 9; // phone numbers have 10-11; year ranges ("2024-2025"), prices, counts stay speakable

/** Rewrites one complete chunk of reply text into speakable text. */
export function toSpeakable(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown link → its label
    .replace(EMAIL, 'the email address on screen')
    .replace(URL_WITH_SCHEME, '')
    .replace(BARE_DOMAIN, '')
    .replace(NUMBER_RUN, (m) => (m.replace(/\D/g, '').length >= MIN_PHONE_DIGITS ? 'the number on screen' : m))
    .replace(/\(\s*\)|\[\s*\]/g, '') // brackets that only held a link
    .replace(/[ \t]+([,.;:!?])/g, '$1') // tidy the gap a removed link leaves before punctuation
    .replace(/[ \t]{2,}/g, ' ');
}

/** Index just past the last sentence end ("." / "!" / "?" + whitespace) or newline, else -1. */
function lastSafeCut(text: string): number {
  let cut = -1;
  for (const m of text.matchAll(/[.!?](?=\s)|\n/g)) cut = (m.index ?? 0) + 1;
  return cut;
}

/**
 * Streaming TTS text transform. Holds text back until a sentence is complete — a link can arrive
 * split across chunks ("https://ex" + "ample.com"), and dots inside a link never count as a
 * sentence end because they are not followed by whitespace — then emits it cleaned.
 */
export function speakableText(text: ReadableStream<string>): ReadableStream<string> {
  let pending = '';
  return text.pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        pending += chunk;
        const cut = lastSafeCut(pending);
        if (cut <= 0) return;
        const ready = toSpeakable(pending.slice(0, cut));
        pending = pending.slice(cut);
        if (ready.trim()) controller.enqueue(ready);
      },
      flush(controller) {
        const rest = toSpeakable(pending);
        if (rest.trim()) controller.enqueue(rest);
      },
    }),
  );
}
