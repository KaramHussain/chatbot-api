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
  category: string | null;
  bestFor: string | null;
}

const cache = new Map<string, LinkRule[]>();

// Two-label country-code suffixes where the registrable domain needs 3 labels, not 2 (e.g.
// "propertydata.co.uk", not "co.uk"). Not exhaustive — just the common ones likely to show up.
const SPECIAL_SECOND_LEVEL_DOMAINS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.in', 'co.nz', 'co.za', 'com.au', 'net.au', 'org.au', 'co.jp',
]);

/**
 * The registrable domain a hostname belongs to — "app.financelobby.com" and "financelobby.com"
 * are the same registrable domain, so a rule entered against one matches a link written against
 * the other (the model is inconsistent about which subdomain it mentions).
 */
function registrableDomain(host: string): string {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (parts.length >= 3 && SPECIAL_SECOND_LEVEL_DOMAINS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/** Splits a domain or full URL into its registrable domain and path (no scheme/query/trailing slash). */
function parseKey(input: string): { host: string; path: string } | null {
  try {
    const trimmed = input.trim();
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withScheme);
    const host = registrableDomain(u.hostname.toLowerCase().replace(/^www\./, ''));
    const path = u.pathname.replace(/\/+$/, '');
    return { host, path: path === '/' ? '' : path };
  } catch {
    return null;
  }
}

function normalizeDomain(domain: string): string {
  return parseKey(domain)?.host ?? domain.trim().toLowerCase();
}

export async function refreshBotLinkRules(botId: string): Promise<LinkRule[]> {
  const rows = await db.select().from(botLinkRules).where(eq(botLinkRules.botId, botId));
  const rules = rows.map((r) => ({
    id: r.id,
    matchDomain: r.matchDomain,
    targetUrl: r.targetUrl,
    label: r.label,
    category: r.category ?? null,
    bestFor: r.bestFor ?? null,
  }));
  cache.set(botId, rules);
  return rules;
}

export async function getBotLinkRules(botId: string): Promise<LinkRule[]> {
  const cached = cache.get(botId);
  if (cached) return cached;
  return refreshBotLinkRules(botId);
}

/**
 * Several vendors can sit behind the same short-link domain (e.g. fxo.co/ABC vs fxo.co/XYZ) — a
 * plain hostname can't tell those apart. When two or more rules in this set share a hostname,
 * each of those rules (only those) gets its stored match key narrowed to hostname + the path
 * from its own target URL, so they stay distinct and never collide or silently overwrite each
 * other. A rule whose hostname is unique among this bot's rules keeps the broad, path-agnostic
 * hostname match — the common case, and the one that still catches a plain vendor domain the
 * model wrote instead of using the configured link.
 */
type RuleInput = { matchDomain: string; targetUrl: string; label?: string | null; category?: string | null; bestFor?: string | null };

function disambiguate(rules: RuleInput[]): RuleInput[] {
  const hostCounts = new Map<string, number>();
  for (const r of rules) {
    const host = parseKey(r.matchDomain)?.host;
    if (host) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
  }
  return rules.map((r) => {
    const host = parseKey(r.matchDomain)?.host;
    if (!host || (hostCounts.get(host) ?? 0) < 2) return { ...r, matchDomain: host ?? r.matchDomain };
    const targetPath = parseKey(r.targetUrl)?.path ?? '';
    return { ...r, matchDomain: targetPath ? `${host}${targetPath}` : host };
  });
}

export async function setBotLinkRules(botId: string, rules: RuleInput[]): Promise<LinkRule[]> {
  const resolved = disambiguate(rules);
  await db.delete(botLinkRules).where(eq(botLinkRules.botId, botId));
  if (resolved.length) {
    await db.insert(botLinkRules).values(
      resolved.map((r) => ({
        botId,
        matchDomain: r.matchDomain,
        targetUrl: r.targetUrl,
        label: r.label ?? null,
        category: r.category ?? null,
        bestFor: r.bestFor ?? null,
      })),
    );
  }
  return refreshBotLinkRules(botId);
}

/**
 * Builds a "Partner directory" block from link rules that have category/bestFor enrichment.
 * When a tenant has the `affiliateDirectory` feature flag enabled, the chat route appends this
 * to the system prompt at request time — the stored system prompt then holds only the framing
 * instructions (identity, recommendation logic, style, hard rules), and the directory is always
 * in sync with the Links tab: add a partner there, it appears in the model's guidance instantly.
 *
 * Rules without category/bestFor are silently excluded — they still participate in the URL rewrite
 * but don't appear in the directory (useful for technical alias rows like a short-link domain
 * pointing to the same partner, e.g. the fxo.co paths).
 */
export function buildDirectorySection(rules: LinkRule[]): string {
  // Only include rules that have at least a label and targetUrl
  const entries = rules.filter((r) => r.label && r.targetUrl);
  if (!entries.length) return '';

  // Group by category; uncategorised entries appear under a generic heading
  const byCategory = new Map<string, LinkRule[]>();
  for (const rule of entries) {
    const cat = rule.category?.trim() || 'Other';
    const list = byCategory.get(cat) ?? [];
    list.push(rule);
    byCategory.set(cat, list);
  }

  const lines: string[] = [
    '# Partner directory — the ONLY companies you may recommend',
    '',
    'Use the exact link shown for each partner. Never link to any company not in this list.',
    '',
  ];

  for (const [cat, catRules] of byCategory) {
    lines.push(`## ${cat}`);
    for (const rule of catRules) {
      const name = rule.label!;
      const bestFor = rule.bestFor?.trim() ? `; best for ${rule.bestFor.trim()}` : '';
      lines.push(`- ${name}${bestFor}. Link: ${rule.targetUrl}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// Matches a markdown link `[label](url)` or a bare http(s)/www URL, same shape the widget itself
// linkifies — kept in sync with widget/src/frame/ChatApp.tsx's `inlineMd` regex intentionally.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s"<>)]+)\)|\b(?:https?:\/\/|www\.)[^\s<>"'`)]+/gi;

interface RuleIndexEntry { path: string; rule: LinkRule }

/** Groups rules by hostname once per call so a shared short-link host can hold several targets. */
function buildIndex(rules: LinkRule[]): Map<string, RuleIndexEntry[]> {
  const index = new Map<string, RuleIndexEntry[]>();
  for (const rule of rules) {
    const key = parseKey(rule.matchDomain);
    if (!key) continue;
    const list = index.get(key.host) ?? [];
    list.push({ path: key.path, rule });
    index.set(key.host, list);
  }
  return index;
}

function findRule(index: Map<string, RuleIndexEntry[]>, url: string): LinkRule | undefined {
  const candidate = parseKey(url);
  if (!candidate) return undefined;
  const entries = index.get(candidate.host);
  if (!entries?.length) return undefined;
  // A single rule for this host is a broad, path-agnostic match (the common case — also what
  // catches a plain vendor domain the model wrote instead of the configured link). Multiple rules
  // sharing a host (a shared short-link domain) require an exact path match to stay unambiguous.
  if (entries.length === 1) return entries[0].rule;
  return entries.find((e) => e.path && (candidate.path === e.path || candidate.path.startsWith(`${e.path}/`)))?.rule;
}

// The model sometimes writes a bracketed caption right before a bare URL instead of proper
// markdown link syntax — "[PropStream Affiliate Link] https://..." with no parentheses — which
// the widget can't connect: the bracket renders as dangling literal text and the URL becomes its
// own separate link. Normalize that shape into real markdown `[label](url)` first, so the main
// pass below sees one clean link instead of two disconnected pieces.
const DANGLING_LABEL_RE = /\[([^\]\n]{1,120})\]:?\s+((?:https?:\/\/|www\.)[^\s<>"'`)]+)/gi;

/**
 * Rewrites any recognized link in `text` to its configured target URL, in place. A markdown link
 * keeps whatever label the model wrote (e.g. "[TEKCE Dubai Properties](...)"); a bare URL — which
 * has no label to keep — is upgraded to a markdown link using the rule's own label (falling back
 * to its domain), so the visitor sees a short readable name instead of a raw tracking URL.
 */
export function rewriteLinkRules(text: string, rules: LinkRule[]): string {
  if (!rules.length) return text;
  const index = buildIndex(rules);
  const normalized = text.replace(DANGLING_LABEL_RE, (match, label, url) => (findRule(index, url) ? `[${label}](${url})` : match));
  return normalized.replace(LINK_RE, (match, mdLabel, mdUrl) => {
    const url = mdUrl ?? match;
    const rule = findRule(index, url);
    if (!rule) return match;
    const label = mdLabel ?? rule.label ?? parseKey(rule.matchDomain)?.host ?? rule.matchDomain;
    return `[${label}](${rule.targetUrl})`;
  });
}
