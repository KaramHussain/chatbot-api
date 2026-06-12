import type { ChatSource } from '../types/index.js';
/**
 * Hybrid retrieval: dense vector search + PostgreSQL full-text search (FTS),
 * fused with Reciprocal Rank Fusion (RRF, k=60).
 *
 * Why hybrid matters:
 *   - Vector search: semantic queries ("how do I reach you?")
 *   - FTS: exact keyword hits (phone numbers, emails, names, product codes)
 *     that score poorly in pure vector space
 *   - RRF: chunks appearing in both lists are boosted to the top
 */
export declare function retrieveContext(params: {
    botId: string;
    tenantId: string;
    query: string;
    topK?: number;
}): Promise<ChatSource[]>;
export declare function buildRagPrompt(params: {
    botSystemPrompt: string | null;
    sources: ChatSource[];
    responseStyle?: string | null;
}): string;
//# sourceMappingURL=rag.d.ts.map