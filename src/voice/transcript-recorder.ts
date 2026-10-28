// Persists a voice call's committed turns as plain text (no audio is ever stored).
// Writes are serialised so turns land in the database in the order they were spoken, and
// `flush()` lets the agent wait for pending writes before the job process exits.
import { saveMessage, touchConversation, type TurnRole } from '../lib/conversation.js';

export class TranscriptRecorder {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly conversationId: string,
    private readonly onError: (err: unknown) => void = (err) => console.error('Transcript write failed:', err),
  ) {}

  record(role: TurnRole, text: string): void {
    const content = text.trim();
    if (!content) return;
    this.tail = this.tail
      .then(async () => {
        await saveMessage(this.conversationId, { role, content });
        await touchConversation(this.conversationId, 1);
      })
      .catch(this.onError);
  }

  flush(): Promise<void> {
    return this.tail;
  }
}
