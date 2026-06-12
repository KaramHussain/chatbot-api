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
}
export declare function streamChat(options: StreamChatOptions): AsyncGenerator<string>;
//# sourceMappingURL=bedrock.d.ts.map