// Per-bot, owner-editable domain → URL rewrite rules (see db/schema.ts `botLinkRules`). General
// purpose: affiliate/referral codes, UTM-tagged tracking links, a rebranded short-link domain, or
// redirecting a vendor's site to a different URL entirely. The chat route runs every finished
// reply through `rewriteLinkRules` so a link the LLM wrote from its own knowledge/RAG context is
// swapped for the exact configured target — correctness never depends on the model reproducing a
// long tracking URL from memory, and retrieval luck never matters.
//
// Opt-in and fully isolated per bot: a bot with no rules configured is untouched (the function
// returns its input unchanged), so this never affects any other bot.
import { db, botLinkRules } from '../db/index.js';
import { eq } from 'drizzle-orm';

export interface LinkRule {
  id: string;
  matchDomain: string;
  targetUrl: string;
  label: string | null;
}

const cache = new Map<string, LinkRule[]>();

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');
}

export async function refreshBotLinkRules(botId: string): Promise<LinkRule[]> {
  const rows = await db.select().from(botLinkRules).where(eq(botLinkRules.botId, botId));
  const rules = rows.map((r) => ({ id: r.id, matchDomain: normalizeDomain(r.matchDomain), targetUrl: r.targetUrl, label: r.label }));
  cache.set(botId, rules);
  return rules;
}

export async function getBotLinkRules(botId: string): Promise<LinkRule[]> {
  const cached = cache.get(botId);
  if (cached) return cached;
  return refreshBotLinkRules(botId);
}

export async function setBotLinkRules(botId: string, rules: { matchDomain: string; targetUrl: string; label?: string | null }[]): Promise<LinkRule[]> {
  await db.delete(botLinkRules).where(eq(botLinkRules.botId, botId));
  if (rules.length) {
    await db.insert(botLinkRules).values(
      rules.map((r) => ({ botId, matchDomain: normalizeDomain(r.matchDomain), targetUrl: r.targetUrl, label: r.label ?? null })),
    );
  }
  return refreshBotLinkRules(botId);
}

// Matches a markdown link `[label](url)` or a bare http(s)/www URL, same shape the widget itself
// linkifies — kept in sync with widget/src/frame/ChatApp.tsx's `inlineMd` regex intentionally.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s"<>)]+)\)|\b(?:https?:\/\/|www\.)[^\s<>"'`)]+/gi;

function hostOf(url: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return normalizeDomain(new URL(withScheme).hostname);
  } catch {
    return null;
  }
}

/** Rewrites any recognized link in `text` to its configured target URL, in place. */
export function rewriteLinkRules(text: string, rules: LinkRule[]): string {
  if (!rules.length) return text;
  const byDomain = new Map(rules.map((r) => [r.matchDomain, r.targetUrl]));
  return text.replace(LINK_RE, (match, mdLabel, mdUrl) => {
    const url = mdUrl ?? match;
    const host = hostOf(url);
    const targetUrl = host ? byDomain.get(host) : undefined;
    if (!targetUrl) return match;
    return mdLabel ? `[${mdLabel}](${targetUrl})` : targetUrl;
  });
}
