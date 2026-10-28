import { type Message as BedrockMessage } from '@aws-sdk/client-bedrock-runtime';
export declare function embedText(text: string): Promise<number[]>;
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}
export interface StreamChatOptions {
    systemPrompt?: string;
    history: ChatMessage[];
    userMessage: string;
    modelId?: string;
    onTokenUsage?: (inputTokens: number, outputTokens: number) => void;
    /** Aborts the Bedrock request (e.g. the user interrupted the voice agent). */
    signal?: AbortSignal;
}
/**
 * Bedrock Converse requires a conversation that starts with the user and strictly alternates
 * user/assistant. Stored history can violate that (e.g. a reply that failed left two user turns in
 * a row), which makes Bedrock reject the whole request — so normalise defensively: drop empty
 * turns, drop leading assistant turns, and merge consecutive same-role turns.
 */
export declare function toConverseMessages(history: ChatMessage[], userMessage: string): BedrockMessage[];
export declare function streamChat(options: StreamChatOptions): AsyncGenerator<string>;
//# sourceMappingURL=bedrock.d.ts.map