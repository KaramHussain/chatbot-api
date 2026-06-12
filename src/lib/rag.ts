import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { embedText } from './bedrock.js';
import type { ChatSource } from '../types/index.js';

const TOP_K = 10;
const MIN_VECTOR_SCORE = 0.20; // discard chunks with very low vector similarity

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
export async function retrieveContext(params: {
  botId: string;
  tenantId: string;
  query: string;
  topK?: number;
}): Promise<ChatSource[]> {
  const { botId, tenantId, query, topK = TOP_K } = params;

  const queryEmbedding = await embedText(query);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  // websearch_to_tsquery handles special chars gracefully (no exceptions on empty input)
  const results = await db.execute(sql`
    WITH vector_ranked AS (
      SELECT
        bc.id,
        bc.content,
        bc.metadata,
        bc.document_id,
        ROW_NUMBER() OVER (ORDER BY bc.embedding <=> ${embeddingStr}::vector) AS rank
      FROM bot_chunks bc
      JOIN bot_documents bd ON bd.id = bc.document_id
      WHERE bc.bot_id = ${botId}
        AND bc.tenant_id = ${tenantId}
        AND bd.status = 'ready'
        AND (1 - (bc.embedding <=> ${embeddingStr}::vector)) >= ${MIN_VECTOR_SCORE}
      LIMIT 30
    ),
    text_ranked AS (
      SELECT
        bc.id,
        bc.content,
        bc.metadata,
        bc.document_id,
        ROW_NUMBER() OVER (
          ORDER BY ts_rank_cd(
            to_tsvector('english', bc.content),
            websearch_to_tsquery('english', ${query})
          ) DESC
        ) AS rank
      FROM bot_chunks bc
      JOIN bot_documents bd ON bd.id = bc.document_id
      WHERE bc.bot_id = ${botId}
        AND bc.tenant_id = ${tenantId}
        AND bd.status = 'ready'
        AND to_tsvector('english', bc.content) @@ websearch_to_tsquery('english', ${query})
      LIMIT 30
    ),
    rrf AS (
      SELECT
        COALESCE(v.id, t.id)                   AS id,
        COALESCE(v.content, t.content)         AS content,
        COALESCE(v.metadata, t.metadata)       AS metadata,
        COALESCE(v.document_id, t.document_id) AS document_id,
        COALESCE(1.0 / (60 + v.rank), 0.0) +
        COALESCE(1.0 / (60 + t.rank), 0.0)    AS rrf_score
      FROM vector_ranked v
      FULL OUTER JOIN text_ranked t ON v.id = t.id
    )
    SELECT
      r.id,
      r.content,
      r.metadata,
      r.document_id,
      r.rrf_score,
      bd.name AS document_name
    FROM rrf r
    JOIN bot_documents bd ON bd.id = r.document_id
    ORDER BY r.rrf_score DESC
    LIMIT ${topK}
  `);

  return (results as any[]).map((row) => ({
    documentId: row.document_id as string,
    documentName: row.document_name as string,
    chunkContent: row.content as string,
    metadata: row.metadata as Record<string, string> | null,
    score: parseFloat(row.rrf_score as string),
  }));
}

const STYLE_INSTRUCTIONS: Record<string, string> = {
  concise: 'Keep your response short and direct. Maximum 3 sentences. No filler text.',
  very_concise: 'Answer in 1–2 sentences only. Be extremely direct.',
  detailed: 'Provide comprehensive answers with context, background, and relevant examples.',
  bullet_points: 'Always structure your response using bullet points or numbered lists.',
  professional: 'Use a formal, professional business tone. Avoid contractions and casual language.',
  friendly: 'Be warm, friendly, and conversational. Show genuine empathy when appropriate.',
};

export function buildRagPrompt(params: {
  botSystemPrompt: string | null;
  sources: ChatSource[];
  responseStyle?: string | null;
}): string {
  const { botSystemPrompt, sources, responseStyle } = params;

  const contextBlock =
    sources.length > 0
      ? sources
          .map((s, i) => {
            const pageLabel = (s.metadata as any)?.page_title
              ? ` (${(s.metadata as any).page_title})`
              : '';
            return `[Context ${i + 1}${pageLabel}]\n${s.chunkContent}`;
          })
          .join('\n\n')
      : 'No relevant documents found.';

  const base = botSystemPrompt?.trim()
    ? botSystemPrompt.trim()
    : 'You are a helpful assistant.';

  const styleInstruction =
    responseStyle && STYLE_INSTRUCTIONS[responseStyle]
      ? `\n${STYLE_INSTRUCTIONS[responseStyle]}`
      : '';

  return `${base}${styleInstruction}

Answer the user's question using the context below. Be direct and conversational. When the context includes page URLs or links, include them in your answer so the user can navigate directly. Do not mention "context", "documents", or "sources" — just answer naturally. If the context does not contain the answer, say you don't know.

--- CONTEXT ---
${contextBlock}
--- END CONTEXT ---`;
}
