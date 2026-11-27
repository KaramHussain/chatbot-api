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
    .replace(/(?:learn more|find out more) at (?=(?:https?:\/\/|www\.|[\w-]+\.\w{2,}))/gi, 'learn more using ')
    .replace(/\*\*|__|^\s*[-*#]+\s+/gm, '')
    .replace(EMAIL, 'the email address on screen')
    .replace(URL_WITH_SCHEME, 'the link in this chat')
    .replace(BARE_DOMAIN, 'the link in this chat')
    .replace(NUMBER_RUN, (m) => (m.replace(/\D/g, '').length >= MIN_PHONE_DIGITS ? 'the number on screen' : m))
    .replace(/\(\s*\)|\[\s*\]/g, '') // brackets that only held a link
    .replace(/[ \t]+([,.;:!?])/g, '$1') // tidy the gap a removed link leaves before punctuation
    .replace(/[ \t]{2,}/g, ' ');
}
