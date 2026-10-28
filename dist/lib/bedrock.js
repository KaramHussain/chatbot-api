import { BedrockRuntimeClient, InvokeModelCommand, ConverseStreamCommand, } from '@aws-sdk/client-bedrock-runtime';
import { bedrockAwsConfig } from './aws.js';
const client = new BedrockRuntimeClient(bedrockAwsConfig);
const LLM_MODEL = process.env.BEDROCK_LLM_MODEL ?? 'amazon.nova-lite-v1:0';
const EMBED_MODEL = process.env.BEDROCK_EMBEDDING_MODEL ?? 'amazon.titan-embed-text-v2:0';
const EMBED_DIMS = parseInt(process.env.BEDROCK_EMBEDDING_DIMENSIONS ?? '1024');
// ─── Embeddings ────────────────────────────────────────────────────────────────
export async function embedText(text) {
    const response = await client.send(new InvokeModelCommand({
        modelId: EMBED_MODEL,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
            inputText: text,
            dimensions: EMBED_DIMS,
            normalize: true,
        }),
    }));
    const parsed = JSON.parse(new TextDecoder().decode(response.body));
    return parsed.embedding;
}
/**
 * Bedrock Converse requires a conversation that starts with the user and strictly alternates
 * user/assistant. Stored history can violate that (e.g. a reply that failed left two user turns in
 * a row), which makes Bedrock reject the whole request — so normalise defensively: drop empty
 * turns, drop leading assistant turns, and merge consecutive same-role turns.
 */
export function toConverseMessages(history, userMessage) {
    const turns = [];
    for (const m of [...history, { role: 'user', content: userMessage }]) {
        const content = m.content.trim();
        if (!content)
            continue;
        if (!turns.length && m.role !== 'user')
            continue;
        const last = turns[turns.length - 1];
        if (last && last.role === m.role)
            last.content = `${last.content}\n\n${content}`;
        else
            turns.push({ role: m.role, content });
    }
    return turns.map((m) => ({ role: m.role, content: [{ text: m.content }] }));
}
// Yields text delta chunks as strings; call this inside an SSE handler
export async function* streamChat(options) {
    const { systemPrompt, history, userMessage, modelId = LLM_MODEL, onTokenUsage, signal } = options;
    const messages = toConverseMessages(history, userMessage);
    if (!messages.length)
        return;
    const system = systemPrompt
        ? [{ text: systemPrompt }]
        : undefined;
    const response = await client.send(new ConverseStreamCommand({
        modelId,
        messages,
        system,
        inferenceConfig: {
            maxTokens: 2048,
            temperature: 0.2,
        },
    }), { abortSignal: signal });
    if (!response.stream)
        return;
    for await (const event of response.stream) {
        if (event.contentBlockDelta?.delta?.text) {
            yield event.contentBlockDelta.delta.text;
        }
        if (event.metadata?.usage && onTokenUsage) {
            onTokenUsage(event.metadata.usage.inputTokens ?? 0, event.metadata.usage.outputTokens ?? 0);
        }
    }
}
//# sourceMappingURL=bedrock.js.map