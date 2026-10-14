// server.js — DTU SEO Page Auditor
// TinyFish Fetch + Search + Agent → AI readability, search visibility, render gap, same-day fixes.
//
// Setup (Node 18+):
//   npm init -y && npm i express
//   export TINYFISH_API_KEY=...            (required)
//   export LLM_API_KEY=...                 (optional; any OpenAI-compatible API)
//   export LLM_BASE_URL=https://api.openai.com/v1   (optional; e.g. Groq/Gemini OpenAI-compatible URL)
//   export LLM_MODEL=gpt-4o-mini           (optional)
//   node server.js
//
// Routes (GET with query params or POST with JSON body):
//   /api/fetch-audit?url=...                       TinyFish Fetch (+ LLM) → AI readability score
//   /api/visibility-gap?url=...&query=...          TinyFish Search (+ Fetch for term coverage) → ranking gaps
//   /api/render-gap?url=...                        TinyFish Agent vs Fetch → content AI tools miss
//   /api/final-report?url=...&query=...&render=true  All of the above → prioritized same-day fixes

const express = require('express');

const TF_KEY = process.env.TINYFISH_API_KEY;
const LLM_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const LLM_BASE = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const SEARCH_LOCATION = process.env.SEARCH_LOCATION || '';
const PORT = process.env.PORT || 3000;

if (!TF_KEY) {
  console.error('Missing TINYFISH_API_KEY environment variable.');
  process.exit(1);
}

const AI_BOTS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-Web', 'anthropic-ai',
  'PerplexityBot', 'Google-Extended', 'CCBot', 'Applebot-Extended', 'Bytespider',
];

// ---------------------------------------------------------------- HTTP helper
async function http(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const raw = await res.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    if (!res.ok) {
      const detail = typeof body === 'string' ? body : JSON.stringify(body);
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${detail.slice(0, 300)}`);
    }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs / 1000}s calling ${new URL(url).host}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- TinyFish client
const tinyfish = {
  // POST https://api.fetch.tinyfish.ai — up to 10 URLs in parallel, live (ttl: 0)
  fetch(urls) {
    return http('https://api.fetch.tinyfish.ai', {
      method: 'POST',
      headers: { 'X-API-Key': TF_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, format: 'markdown', links: true, page_metadata: true, ttl: 0 }),
    }, 150000);
  },
  // GET https://api.search.tinyfish.ai?query=...
  search(query) {
    const qs = new URLSearchParams({ query, language: 'en' });
    if (SEARCH_LOCATION) qs.set('location', SEARCH_LOCATION);
    return http(`https://api.search.tinyfish.ai?${qs}`, { headers: { 'X-API-Key': TF_KEY } }, 20000);
  },
  // POST https://agent.tinyfish.ai/v1/automation/run — synchronous goal-based browser run
  agent(url, goal) {
    return http('https://agent.tinyfish.ai/v1/automation/run', {
      method: 'POST',
      headers: { 'X-API-Key': TF_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, goal }),
    }, 180000);
  },
};

// ---------------------------------------------------------------- Utilities
function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) throw badRequest('Missing "url" parameter');
  const s = raw.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!u.hostname.includes('.')) throw new Error();
    return u.toString();
  } catch {
    throw badRequest(`Invalid URL: ${s}`);
  }
}

const hostOf = (u) => new URL(u).hostname.replace(/^www\./, '').toLowerCase();
const pageKey = (u) => {
  const x = new URL(u);
  return (hostOf(u) + x.pathname.replace(/\/+$/, '')).toLowerCase();
};
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
const words = (s) => (s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const STOP = new Set(('the a an and or of to in on for with is are was be by at from as it this that your you we our ' +
  'how what why who when where which can will best top vs near more most into about').split(' '));
const keyTerms = (s) => [...new Set(words(s).filter((w) => w.length > 2 && !STOP.has(w)))];

function metaValue(pm, ...paths) {
  if (!pm || typeof pm !== 'object') return null;
  for (const p of paths) {
    let v = pm;
    for (const part of p.split('.')) v = v == null ? undefined : v[part];
    if (v) return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : JSON.stringify(v);
  }
  return null;
}

function parseJsonLoose(x) {
  if (x == null) return null;
  if (typeof x === 'object') return x;
  const s = String(x).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return { raw: s };
}

// ---------------------------------------------------------------- LLM (optional)
async function llmJSON(system, user) {
  if (!LLM_KEY) return { skipped: true, reason: 'LLM_API_KEY not set' };
  try {
    const r = await http(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    }, 60000);
    return parseJsonLoose(r.choices?.[0]?.message?.content || '{}');
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------- Fetch bundle (page + robots.txt + llms.txt in one call)
async function getPageBundle(url) {
  const origin = new URL(url).origin;
  const robotsUrl = `${origin}/robots.txt`;
  const llmsUrl = `${origin}/llms.txt`;
  const data = await tinyfish.fetch([url, robotsUrl, llmsUrl]);
  const results = Array.isArray(data?.results) ? data.results : [];
  const errors = Array.isArray(data?.errors) ? data.errors : [];

  const isFile = (r, name) => /\.txt$/i.test(r.url || '') && (r.url || '').toLowerCase().endsWith(`/${name}`);
  const page = results.find((r) => !isFile(r, 'robots.txt') && !isFile(r, 'llms.txt'));
  const robots = results.find((r) => isFile(r, 'robots.txt'));
  const llms = results.find((r) => isFile(r, 'llms.txt'));

  if (!page) {
    const err = errors.find((e) => !/\/(robots|llms)\.txt$/i.test(e?.url || '')) || errors[0];
    const e = new Error(`TinyFish Fetch could not read the page: ${err ? JSON.stringify(err).slice(0, 300) : 'no result returned'}`);
    e.status = 502;
    throw e;
  }
  return { url, page, robots, llms, fetch_errors: errors };
}

// ---------------------------------------------------------------- robots.txt / llms.txt
function parseRobots(result) {
  const txt = result?.text || '';
  if (!txt || !/user-agent\s*:/i.test(txt)) {
    return { found: false, blocked: [], allowed: AI_BOTS, note: 'No readable robots.txt — AI crawlers are allowed by default.' };
  }
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const l = line.replace(/#.*/, '').replace(/\\/g, '').trim();
    const m = l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'disallow' || key === 'allow')) cur.rules.push({ key, val });
    }
  }
  const blocksAll = (g) => !!g && g.rules.some((r) => r.key === 'disallow' && r.val === '/') &&
    !g.rules.some((r) => r.key === 'allow' && r.val === '/');
  const star = groups.find((g) => g.agents.includes('*'));
  const blocked = [];
  const allowed = [];
  for (const bot of AI_BOTS) {
    const g = groups.find((x) => x.agents.includes(bot.toLowerCase())) || star;
    (blocksAll(g) ? blocked : allowed).push(bot);
  }
  return { found: true, blocked, allowed };
}

function parseLlmsTxt(result) {
  const txt = result?.text || '';
  const looks404 = /404|not found|page doesn.t exist/i.test(`${result?.title || ''} ${txt.slice(0, 300)}`);
  return { found: txt.length > 30 && !looks404, preview: txt.length > 30 && !looks404 ? clip(txt, 200) : null };
}

// ---------------------------------------------------------------- Endpoint 1 logic: AI readability
const CHECK_LABELS = {
  content_extracted: 'Readable content',
  title: 'Page title',
  meta_description: 'Meta description',
  heading_structure: 'Heading structure',
  single_h1: 'Single H1',
  chunkable_paragraphs: 'Chunk-friendly paragraphs',
  structured_lists_tables: 'Lists and tables',
  canonical: 'Canonical URL',
  indexable: 'Indexable (no noindex)',
  ai_crawlers_allowed: 'AI crawlers allowed',
  llms_txt: 'llms.txt file',
};
const DEPENDS_ON_CONTENT = ['heading_structure', 'single_h1', 'chunkable_paragraphs', 'structured_lists_tables'];

function analyzeReadability(page, robots, llms) {
  const text = page.text || '';
  const lines = text.split('\n');
  const headings = lines.filter((l) => /^#{1,6}\s+\S/.test(l)).map((l) => l.replace(/^#+\s+/, '').trim());
  const h1s = lines.filter((l) => /^#\s+\S/.test(l)).map((l) => l.replace(/^#\s+/, '').trim());
  const listItems = lines.filter((l) => /^\s*([-*+]|\d+\.)\s+\S/.test(l)).length;
  const tableRows = lines.filter((l) => /^\s*\|.+\|\s*$/.test(l)).length;
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^#/.test(p));
  const paraWords = paragraphs.map((p) => words(p).length);
  const longParas = paragraphs.filter((_, i) => paraWords[i] > 150);
  const wordCount = words(text).length;
  const avgPara = paragraphs.length ? Math.round(paraWords.reduce((a, b) => a + b, 0) / paragraphs.length) : 0;

  const isHome = safe(() => ['', '/'].includes(new URL(page.final_url || page.url).pathname), false);
  const pm = page.page_metadata || {};
  const title = page.title || metaValue(pm, 'og.title', 'og:title');
  const description = page.description || metaValue(pm, 'description', 'other.description');
  const canonical = metaValue(pm, 'canonical', 'canonical_url', 'canonicalUrl');
  const robotsMeta = metaValue(pm, 'robots', 'other.robots');
  const ogTitle = metaValue(pm, 'og.title', 'og.og:title', 'og:title');
  const ogDescription = metaValue(pm, 'og.description', 'og.og:description', 'og:description');

  const checks = [];
  let score = 0;
  const add = (id, pass, weight, detail, fix) => {
    checks.push({ id, label: CHECK_LABELS[id] || id, pass, weight, detail, fix: pass ? null : fix });
    if (pass) score += weight;
  };

  add('content_extracted', wordCount >= 300, 20,
    `${wordCount} words of main content extracted by AI fetch`,
    wordCount < 50
      ? 'AI fetch extracted almost no text. The content is probably rendered by JavaScript or blocked. Server-render the main content (SSR/SSG) so it exists in the initial HTML.'
      : `Only ${wordCount} words are readable by AI tools. Add a crawlable section of at least 300 words that directly answers what this page is about.`);

  add('title', !!title && title.length >= 10 && title.length <= 65, 10,
    title ? `Title: "${clip(title, 100)}" (${title.length} chars)` : 'No <title> found',
    !title ? 'Add a <title> of 30–60 characters naming the page topic first.'
      : title.length > 65 ? `Title is ${title.length} chars and will be truncated. Cut "${clip(title, 100)}" to under 60 chars, main keyword first.`
        : isHome
          ? `The homepage title is just "${title}". Use "${title} – <what you offer in 3–6 words>" (30–60 chars) so search and AI tools know what the site does, not only its name.`
          : `Title "${title}" is too short to describe the page. Expand to 30–60 chars with the main keyword.`);

  add('meta_description', !!description && description.length >= 50 && description.length <= 160, 10,
    description ? `Meta description (${description.length} chars): "${clip(description, 160)}"` : 'No meta description',
    !description ? 'Add a 120–155 character meta description summarizing the page; AI search and Google both use it for snippets.'
      : description.length < 50 ? `Meta description is only ${description.length} chars. Expand to 120–155 chars with the main benefit and keyword.`
        : `Meta description is ${description.length} chars and will be cut off. Trim to under 155 chars.`);

  add('heading_structure', headings.length >= 3, 10,
    `${headings.length} headings found in extracted content${headings.length ? `: ${headings.slice(0, 5).map((h) => `"${clip(h, 50)}"`).join(', ')}` : ''}`,
    'AI tools split pages into chunks by heading. Add H2/H3 headings every 150–300 words, phrased as the questions the section answers.');

  add('single_h1', h1s.length === 1, 5,
    `${h1s.length} H1 heading(s)${h1s.length ? `: ${h1s.slice(0, 3).map((h) => `"${clip(h, 60)}"`).join(', ')}` : ''}`,
    h1s.length === 0 ? 'No H1 is visible to AI fetch. Add exactly one <h1> stating the page topic.' : `There are ${h1s.length} H1s. Keep one H1 for the main topic and change the others to H2.`);

  add('chunkable_paragraphs', wordCount >= 100 && longParas.length === 0, 10,
    wordCount < 100 ? `Only ${wordCount} words extracted, too little to form useful answer chunks`
      : longParas.length ? `${longParas.length} paragraph(s) over 150 words, e.g. "${clip(longParas[0], 100)}"` : `Average paragraph: ${avgPara} words`,
    wordCount < 100 ? 'Once the main content is readable, keep paragraphs to 2–4 sentences, each starting with the key fact.'
      : 'Break paragraphs over 150 words into 2–4 sentence blocks, each starting with the key fact, so RAG chunks stay self-contained.');

  add('structured_lists_tables', listItems + tableRows >= 3, 5,
    `${listItems} list items, ${tableRows} table rows`,
    'Add at least one bulleted list or table (features, steps, specs, prices). AI tools extract and quote structured blocks far more reliably than prose.');

  add('canonical', !!canonical, 5,
    canonical ? `Canonical: ${canonical}` : 'No canonical URL found',
    `Add <link rel="canonical" href="${page.final_url || page.url}"> so search and AI tools attribute this content to one URL.`);

  add('indexable', !(robotsMeta && /noindex/i.test(robotsMeta)), 10,
    robotsMeta ? `Meta robots: "${robotsMeta}"` : 'No meta robots restriction',
    `Meta robots is "${robotsMeta}". Remove "noindex" if this page should appear in search and AI answers.`);

  add('ai_crawlers_allowed', robots.blocked.length === 0, 10,
    robots.found ? (robots.blocked.length ? `robots.txt blocks: ${robots.blocked.join(', ')}` : 'robots.txt allows all major AI crawlers') : robots.note,
    `robots.txt blocks ${robots.blocked.join(', ')}. If you want to appear in ChatGPT, Claude, Perplexity or Gemini answers, add "User-agent: <bot>" + "Allow: /" for the ones you want.`);

  add('llms_txt', llms.found, 5,
    llms.found ? '/llms.txt is present' : 'No /llms.txt found',
    'Add /llms.txt at the site root: a short markdown summary of the site plus links to its key pages, written for AI tools.');

  if (wordCount < 50) {
    for (const c of checks) {
      if (!c.pass && DEPENDS_ON_CONTENT.includes(c.id)) c.root_cause = 'content_extracted';
    }
  }

  return {
    heuristic_score: score,
    stats: { words: wordCount, headings: headings.length, h1: h1s.length, list_items: listItems, table_rows: tableRows, paragraphs: paragraphs.length, avg_paragraph_words: avgPara, outbound_links: Array.isArray(page.links) ? page.links.length : null },
    metadata: { title, description, canonical, robots_meta: robotsMeta, og_title: ogTitle, og_description: ogDescription, author: page.author || null, published_date: page.published_date || null, language: page.language || null },
    headings: headings.slice(0, 20),
    checks,
  };
}

async function aiUnderstanding(url, page) {
  const system = 'You are an AI search engine. You can see a web page ONLY through the extracted text given to you. ' +
    'Answer strictly from that text. If something is missing or unclear, say so. Respond with JSON only.';
  const user = `URL: ${url}\nTITLE: ${page.title || '(none)'}\nDESCRIPTION: ${page.description || '(none)'}\n\n` +
    `EXTRACTED TEXT (exactly what AI tools receive):\n${clip(page.text || '', 9000) || '(empty)'}\n\n` +
    'Return JSON with keys: ' +
    '"what_this_page_is" (1-2 sentences, as you understand it), ' +
    '"confidence" (0-100), ' +
    '"questions_this_page_answers" (3-5 strings), ' +
    '"search_queries_it_should_rank_for" (3 short search queries a real user would type), ' +
    '"rag_readiness_score" (0-100: could an AI quote accurate, self-contained answers from this text?), ' +
    '"rag_readiness_reasons" (2-4 strings), ' +
    '"unclear_or_missing_for_ai" (2-5 specific gaps referencing this page, not generic advice), ' +
    '"best_quotable_passage" (a passage under 40 words copied from the text, or null).';
  return llmJSON(system, user);
}

async function fetchAudit(url, bundle) {
  const b = bundle || await getPageBundle(url);
  const robots = parseRobots(b.robots);
  const llms = parseLlmsTxt(b.llms);
  const analysis = analyzeReadability(b.page, robots, llms);
  const ai = await aiUnderstanding(url, b.page);
  const rag = typeof ai?.rag_readiness_score === 'number' ? ai.rag_readiness_score : null;
  const score = rag == null ? analysis.heuristic_score : Math.round(analysis.heuristic_score * 0.6 + rag * 0.4);
  return {
    url,
    final_url: b.page.final_url || b.page.url,
    tinyfish_used: ['fetch'],
    ai_readability: { score, grade: grade(score), heuristic_score: analysis.heuristic_score, rag_readiness_score: rag },
    ai_understanding: ai,
    robots_txt: robots,
    llms_txt: llms,
    ...analysis,
    extracted_preview: clip(b.page.text || '', 600),
  };
}

// ---------------------------------------------------------------- Endpoint 2 logic: search visibility
function cleanTitleQuery(title) {
  if (!title) return null;
  const main = title.split(/\s[|\-–—:]\s/)[0].trim();
  return main.length >= 4 ? clip(main, 80) : null;
}

async function visibilityGap(url, query, bundle, aiQueries = []) {
  const b = bundle || await getPageBundle(url);
  const page = b.page;
  const target = pageKey(url);
  const finalTarget = safe(() => pageKey(page.final_url || url), target);
  const domain = hostOf(url);

  const candidates = [];
  if (query) candidates.push({ query: String(query).trim(), source: 'user' });
  const tq = cleanTitleQuery(page.title);
  if (tq) candidates.push({ query: tq, source: 'page_title' });
  for (const q of (Array.isArray(aiQueries) ? aiQueries : []).slice(0, 2)) candidates.push({ query: String(q), source: 'ai_predicted' });
  const seen = new Set();
  const queries = candidates.filter((q) => q.query && !seen.has(q.query.toLowerCase()) && seen.add(q.query.toLowerCase())).slice(0, 4);
  if (!queries.length) throw badRequest('No search query given and the page has no usable title. Pass "query".');

  const lines = (page.text || '').split('\n');
  const headingText = lines.filter((l) => /^#{1,6}\s/.test(l)).join(' ');
  const bodyText = `${page.title || ''} ${page.description || ''} ${page.text || ''}`.toLowerCase();
  const prominentText = `${page.title || ''} ${page.description || ''} ${headingText}`.toLowerCase();

  const results = await Promise.all(queries.map(async (q) => {
    try {
      const r = await tinyfish.search(q.query);
      const list = (Array.isArray(r?.results) ? r.results : []).map((x, i) => ({ ...x, position: x.position ?? i + 1 }));
      const exact = list.find((x) => safe(() => [target, finalTarget].includes(pageKey(x.url)), false));
      const sameDomain = list.filter((x) => safe(() => hostOf(x.url) === domain, false));
      const rank = exact ? exact.position : null;
      const outranked = list
        .filter((x) => safe(() => hostOf(x.url) !== domain, true))
        .filter((x) => (rank ? x.position < rank : true))
        .slice(0, 3)
        .map((x) => ({ position: x.position, site: x.site_name || safe(() => hostOf(x.url), ''), title: x.title, url: x.url, snippet: clip(x.snippet, 160) }));
      const terms = keyTerms(q.query);
      const status = exact ? (rank <= 3 ? 'strong' : 'visible') : sameDomain.length ? 'domain_only' : 'not_found';
      return {
        query: q.query,
        source: q.source,
        status,
        rank,
        your_snippet: exact ? clip(exact.snippet, 200) : null,
        other_page_from_your_domain: !exact && sameDomain[0] ? { position: sameDomain[0].position, url: sameDomain[0].url, title: sameDomain[0].title } : null,
        outranked_by: outranked,
        query_terms: terms,
        terms_missing_from_ai_readable_text: terms.filter((t) => !bodyText.includes(t)),
        terms_missing_from_title_description_headings: terms.filter((t) => !prominentText.includes(t)),
        results_checked: list.length,
      };
    } catch (e) {
      return { query: q.query, source: q.source, error: e.message };
    }
  }));

  const points = { strong: 100, visible: 70, domain_only: 35, not_found: 0 };
  const ok = results.filter((x) => !x.error);
  const score = ok.length ? Math.round(ok.reduce((a, x) => a + points[x.status], 0) / ok.length) : null;

  const readability_link = ok
    .filter((x) => x.status !== 'strong' && (x.terms_missing_from_ai_readable_text.length || x.terms_missing_from_title_description_headings.length))
    .map((x) => x.terms_missing_from_ai_readable_text.length
      ? `Not ranking well for "${x.query}" and AI tools reading this page never see: ${x.terms_missing_from_ai_readable_text.join(', ')}.`
      : `For "${x.query}", the terms ${x.terms_missing_from_title_description_headings.join(', ')} appear only in body text, not in the title, description or headings that search and AI tools weight most.`);

  return {
    url,
    tinyfish_used: ['search', 'fetch'],
    visibility_score: score,
    grade: score == null ? null : grade(score),
    queries: results,
    readability_vs_visibility: readability_link,
  };
}

// ---------------------------------------------------------------- Endpoint 3 logic: Agent render vs Fetch
async function renderGap(url, bundle) {
  const b = bundle || await getPageBundle(url);
  const goal = 'Open this page and wait until it has fully loaded, as a human visitor would. Close any cookie banner. ' +
    'Do NOT log in, submit forms, buy anything, or navigate away from this page. ' +
    'Return ONLY a JSON object with these keys: ' +
    '"main_heading" (string), ' +
    '"page_purpose" (one sentence), ' +
    '"key_content_points" (up to 8 short phrases of exact visible text that matter most: headings, product or service names, prices, key claims), ' +
    '"primary_call_to_action" (string or null), ' +
    '"content_hidden_behind_interaction" (array of short descriptions of content only visible after clicking tabs, accordions, carousels or load-more; empty array if none), ' +
    '"blocked" (true if a captcha, login wall or access-denied page stopped you), ' +
    '"block_reason" (string or null).';

  const run = await tinyfish.agent(url, goal);
  const status = run?.status || null;
  const result = parseJsonLoose(run?.result ?? run?.result_json ?? run?.resultJson ?? null);

  if (!result || result.raw !== undefined || typeof result !== 'object') {
    return { url, tinyfish_used: ['agent', 'fetch'], agent_status: status, render_parity: null, error: 'Agent did not return structured output', agent_raw: clip(JSON.stringify(run), 800) };
  }
  if (result.blocked) {
    return { url, tinyfish_used: ['agent', 'fetch'], agent_status: status, render_parity: null, blocked: true, block_reason: result.block_reason || 'Blocked', fix_hint: 'A browser visitor was blocked (captcha or login wall). AI crawlers will be blocked too.' };
  }

  const fetched = `${b.page.title || ''} ${b.page.text || ''}`.toLowerCase();
  const coverage = (phrase) => {
    const t = keyTerms(phrase);
    if (!t.length) return 1;
    return t.filter((x) => fetched.includes(x)).length / t.length;
  };
  const points = (Array.isArray(result.key_content_points) ? result.key_content_points : []).slice(0, 8).map((p) => {
    const c = coverage(String(p));
    return { visible_text: String(p), in_ai_fetch: c >= 0.6, term_coverage: Math.round(c * 100) };
  });
  const missing = points.filter((p) => !p.in_ai_fetch);
  const headingCov = result.main_heading ? coverage(result.main_heading) : 1;
  const parity = points.length ? Math.round((100 * (points.length - missing.length)) / points.length) : null;

  return {
    url,
    tinyfish_used: ['agent', 'fetch'],
    agent_status: status,
    render_parity: parity,
    browser_view: {
      main_heading: result.main_heading || null,
      page_purpose: result.page_purpose || null,
      primary_call_to_action: result.primary_call_to_action || null,
      content_hidden_behind_interaction: result.content_hidden_behind_interaction || [],
    },
    main_heading_in_ai_fetch: headingCov >= 0.6,
    content_points: points,
    visible_to_humans_but_missing_for_ai: missing.map((p) => p.visible_text),
  };
}

// ---------------------------------------------------------------- Endpoint 4 logic: final report
function grade(s) { return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F'; }

function buildFixes(audit, vis, render) {
  const fixes = [];
  const push = (priority, area, issue, evidence, fix, extra = {}) => fixes.push({ priority, area, issue, evidence, fix, ...extra });

  for (const c of ((audit && audit.checks) || []).filter((x) => !x.pass)) {
    if (c.root_cause) {
      push('low', 'ai_readability', c.label || c.id, c.detail, 'Side effect of the missing content. It should resolve once "Readable content" is fixed.', { root_cause: c.root_cause });
    } else {
      push(c.weight >= 10 ? 'high' : 'medium', 'ai_readability', c.label || c.id, c.detail, c.fix);
    }
  }

  for (const q of ((vis && vis.queries) || []).filter((x) => !x.error)) {
    const top = q.outranked_by[0];
    if (q.status === 'not_found') {
      push('high', 'search_visibility', `Not in top results for "${q.query}"`,
        `Checked ${q.results_checked} results. Ranking instead: ${q.outranked_by.map((o) => `#${o.position} ${o.site}`).join(', ') || 'n/a'}`,
        q.terms_missing_from_ai_readable_text.length
          ? `The page never mentions ${q.terms_missing_from_ai_readable_text.map((t) => `"${t}"`).join(', ')}. Add an H2 section using these exact terms that answers "${q.query}" in its first two sentences.`
          : q.terms_missing_from_title_description_headings.length
            ? `Move ${q.terms_missing_from_title_description_headings.map((t) => `"${t}"`).join(', ')} into the title, meta description and an H2; they are currently buried in body text.`
            : top ? `Content covers the terms but loses to "${clip(top.title, 80)}" (${top.site}). Compare its snippet: "${top.snippet}". Add the specifics it offers that your page lacks.`
              : `Add a dedicated section targeting "${q.query}".`);
    } else if (q.status === 'domain_only') {
      push('medium', 'search_visibility', `Another page on your site ranks for "${q.query}"`,
        `#${q.other_page_from_your_domain.position}: ${q.other_page_from_your_domain.url}`,
        `Decide which URL should own "${q.query}". Either link from ${q.other_page_from_your_domain.url} to this page using the query as anchor text, or make this page's title/H1 match the query more closely.`);
    } else if (q.status === 'visible') {
      push('medium', 'search_visibility', `Ranks #${q.rank} for "${q.query}" (not top 3)`,
        `Above you: ${q.outranked_by.map((o) => `#${o.position} ${o.site}`).join(', ')}. Your snippet: "${q.your_snippet || 'n/a'}"`,
        `Rewrite the title and meta description to lead with "${q.query}" and a concrete benefit; your current snippet is what both Google and AI search show.`);
    }
  }

  if (render && !render.error && !render.blocked) {
    if (render.visible_to_humans_but_missing_for_ai?.length) {
      push('high', 'js_rendering', `${render.visible_to_humans_but_missing_for_ai.length} things visitors see are missing from what AI tools read`,
        render.visible_to_humans_but_missing_for_ai.map((x) => `"${clip(x, 80)}"`).join(', '),
        'This content is injected by JavaScript or loaded late. Render it in the server HTML (SSR/SSG or pre-rendering) so fetch-based AI tools and crawlers receive it.');
    }
    if (render.main_heading_in_ai_fetch === false) {
      push('high', 'js_rendering', 'Main heading is not visible to AI fetch',
        `Browser shows: "${render.browser_view.main_heading}"`,
        'Output the main <h1> in the initial HTML, not via client-side JavaScript.');
    }
    if (render.browser_view.content_hidden_behind_interaction?.length) {
      push('medium', 'js_rendering', 'Content hidden behind clicks',
        render.browser_view.content_hidden_behind_interaction.map((x) => clip(String(x), 80)).join('; '),
        'Keep tab/accordion content in the HTML (hidden with CSS, not fetched on click) so AI tools can read it.');
    }
  } else if (render?.blocked) {
    push('high', 'access', 'Page blocks automated visitors', render.block_reason, 'Allow verified crawlers and AI agents past the captcha or bot wall for public pages, or nothing on this page can be cited.');
  }

  const gaps = Array.isArray(audit?.ai_understanding?.unclear_or_missing_for_ai) ? audit.ai_understanding.unclear_or_missing_for_ai : [];
  for (const g of gaps.slice(0, 3)) {
    push('medium', 'ai_understanding', 'An AI reading this page could not determine', String(g), 'Add one or two explicit sentences on the page that state this directly.');
  }

  const order = { high: 0, medium: 1, low: 2 };
  return fixes.sort((a, b) => order[a.priority] - order[b.priority]).map((f, i) => ({ id: i + 1, ...f }));
}

async function finalReport(url, query, includeRender) {
  const bundle = await getPageBundle(url);
  const renderPromise = includeRender
    ? renderGap(url, bundle).catch((e) => ({ url, error: e.message, render_parity: null }))
    : Promise.resolve(null);

  const audit = await fetchAudit(url, bundle);
  const aiQueries = audit.ai_understanding?.search_queries_it_should_rank_for || [];
  const [vis, render] = await Promise.all([visibilityGap(url, query, bundle, aiQueries), renderPromise]);

  const fixes = buildFixes(audit, vis, render);
  const parts = [audit.ai_readability.score, vis.visibility_score, render?.render_parity].filter((x) => typeof x === 'number');
  const overall = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;

  let summary = null;
  if (LLM_KEY && fixes.length) {
    summary = await llmJSON(
      'You write concise, specific audit summaries for website owners. JSON only.',
      `Page: ${url}\nAI readability: ${audit.ai_readability.score}/100\nSearch visibility: ${vis.visibility_score}/100\n` +
      `Render parity (browser vs AI fetch): ${render?.render_parity ?? 'not checked'}\n` +
      `What an AI thinks the page is: ${audit.ai_understanding?.what_this_page_is || 'unknown'}\n` +
      `Fixes:\n${fixes.slice(0, 10).map((f) => `- [${f.priority}] ${f.issue}: ${f.fix}`).join('\n')}\n\n` +
      'Return JSON: {"headline": one sentence verdict, "why_it_matters": 2 sentences connecting AI readability to search visibility for THIS page, "do_today": [the 3 highest-impact fixes rewritten as concrete tasks]}'
    );
  }

  return {
    url,
    final_url: audit.final_url,
    audited_at: new Date().toISOString(),
    tinyfish_used: ['fetch', 'search', ...(includeRender ? ['agent'] : [])],
    scores: {
      overall,
      overall_grade: overall == null ? null : grade(overall),
      ai_readability: audit.ai_readability.score,
      search_visibility: vis.visibility_score,
      render_parity: render?.render_parity ?? null,
    },
    summary,
    what_ai_thinks_this_page_is: audit.ai_understanding?.what_this_page_is || null,
    fixes,
    details: { fetch_audit: audit, visibility_gap: vis, render_gap: render },
  };
}

// ---------------------------------------------------------------- Server
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const route = (fn) => async (req, res) => {
  const started = Date.now();
  try {
    const input = { ...req.query, ...(req.body || {}) };
    const out = await fn(input);
    res.json({ ok: true, took_ms: Date.now() - started, ...out });
  } catch (e) {
    console.error(`[${req.path}]`, e.message);
    res.status(e.status || 502).json({ ok: false, took_ms: Date.now() - started, error: e.message });
  }
};

const truthy = (v, dflt) => (v === undefined ? dflt : !['false', '0', 'no', false, 0].includes(v));

app.all('/api/fetch-audit', route((i) => fetchAudit(normalizeUrl(i.url))));
const listParam = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split('|') : []).map((x) => String(x).trim()).filter(Boolean);
app.all('/api/visibility-gap', route((i) => visibilityGap(normalizeUrl(i.url), i.query, null, listParam(i.extra_queries))));
app.post('/api/fixes', route(async (i) => ({ fixes: buildFixes(i.audit || null, i.visibility || null, i.render || null) })));
app.all('/api/render-gap', route((i) => renderGap(normalizeUrl(i.url))));
app.all('/api/final-report', route((i) => finalReport(normalizeUrl(i.url), i.query, truthy(i.render, true))));

app.get('/api', (_req, res) => res.json({
  name: 'DTU SEO Page Auditor (TinyFish)',
  llm_enabled: !!LLM_KEY,
  routes: {
    'GET|POST /api/fetch-audit': '{ url } — TinyFish Fetch: what AI tools can read, AI readability score',
    'GET|POST /api/visibility-gap': '{ url, query? } — TinyFish Search: where the page ranks and why not',
    'GET|POST /api/render-gap': '{ url } — TinyFish Agent vs Fetch: content humans see but AI misses',
    'GET|POST /api/final-report': '{ url, query?, render?=true } — everything + prioritized same-day fixes',
  },
  example: '/api/final-report?url=https://example.com&query=example+domain',
}));

// ---------------------------------------------------------------- Dashboard UI (GET /)
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Readability Auditor</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script>
    tailwind.config = { theme: { extend: { fontFamily: { sans: ['Inter', 'sans-serif'], mono: ['JetBrains Mono', 'monospace'] } } } };
  </script>
  <style>
    html { background: #0a0a0b; }
    body {
      background-color: #0a0a0b;
      background-image: radial-gradient(1100px 520px at 50% -180px, rgba(249,115,22,0.13), transparent 70%);
      background-repeat: no-repeat;
      background-attachment: fixed;
      min-height: 100vh;
    }
    .spin { animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .fade-in { animation: fade 0.35s ease-out both; }
    @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .shimmer { background: linear-gradient(90deg, #18181b 0%, #27272a 50%, #18181b 100%); background-size: 200% 100%; animation: sh 1.4s ease-in-out infinite; }
    @keyframes sh { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    .ring-track { stroke: #27272a; }
    details > summary::-webkit-details-marker { display: none; }
  </style>
</head>
<body class="text-zinc-100 font-sans antialiased">
  <main class="max-w-5xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
    <header class="mb-8">
      <div class="flex items-center gap-2 text-[11px] font-mono tracking-[0.2em] text-zinc-400 uppercase">
        <span class="w-2 h-2 rounded-full bg-orange-500"></span> TinyFish Fetch · Search · Agent
      </div>
      <h1 class="mt-3 text-3xl sm:text-5xl font-extrabold tracking-tight">Can AI read your page?</h1>
      <p class="mt-3 text-zinc-400 max-w-2xl">See any live URL the way AI search and fetch tools see it, check where it ranks, and get the exact fixes to ship today.</p>
    </header>

    <form id="form" class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-3 sm:p-4 space-y-3">
      <div class="flex flex-col sm:flex-row gap-3">
        <input id="url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://yoursite.com/page"
          class="flex-1 min-w-0 rounded-xl bg-zinc-950/70 border border-zinc-800 px-4 py-3.5 font-mono text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-orange-500/60 focus:border-orange-500/60 transition">
        <button id="btn" type="submit"
          class="inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-60 disabled:cursor-not-allowed px-6 py-3.5 font-semibold text-zinc-950 transition">
          <svg id="spinner" class="hidden w-4 h-4 spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" opacity="0.25"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>
          <span id="btnText">Analyze Site</span>
        </button>
      </div>
      <div class="flex flex-col sm:flex-row gap-3 sm:items-center">
        <input id="query" type="text" autocomplete="off" placeholder="Target search query (optional), e.g. best running shoes india"
          class="flex-1 min-w-0 rounded-xl bg-zinc-950/70 border border-zinc-800 px-4 py-2.5 text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-orange-500/60 transition">
        <label class="inline-flex items-center gap-2.5 text-sm text-zinc-300 select-none cursor-pointer px-1">
          <input id="useAgent" type="checkbox" checked class="w-4 h-4 accent-orange-500">
          Real-browser check <span class="text-zinc-500">(Agent, ~30–60s)</span>
        </label>
      </div>
    </form>

    <div id="error" class="hidden mt-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"></div>

    <section id="results" class="hidden mt-8 space-y-8">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div class="text-xs font-mono text-zinc-500 truncate" id="auditedUrl"></div>
        <div class="flex flex-wrap gap-2" id="pipeline"></div>
      </div>

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div class="col-span-2 lg:col-span-1 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 flex items-center gap-4">
          <svg class="w-20 h-20 -rotate-90 shrink-0" viewBox="0 0 36 36">
            <circle class="ring-track" cx="18" cy="18" r="15.5" fill="none" stroke-width="3.5"/>
            <circle id="ring" cx="18" cy="18" r="15.5" fill="none" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="97.4" stroke-dashoffset="97.4" style="transition: stroke-dashoffset 0.9s ease, stroke 0.3s"/>
          </svg>
          <div>
            <div class="text-[11px] font-mono uppercase tracking-widest text-zinc-500">Overall</div>
            <div class="mt-1 flex items-baseline gap-2"><span id="overall" class="text-4xl font-extrabold tabular-nums">–</span><span id="overallGrade" class="text-2xl font-extrabold"></span></div>
            <div id="overallLabel" class="text-xs text-zinc-400 mt-0.5"></div>
          </div>
        </div>
        <div id="card-read"></div>
        <div id="card-vis"></div>
        <div id="card-render"></div>
      </div>

      <div id="understanding" class="hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 fade-in">
        <div class="text-[11px] font-mono uppercase tracking-widest text-zinc-500">What an AI thinks this page is, from the fetched text alone</div>
        <p id="understandingText" class="mt-2 text-zinc-200 leading-relaxed"></p>
      </div>

      <div id="linkBox" class="hidden rounded-2xl border border-orange-500/25 bg-orange-500/[0.06] p-5 fade-in">
        <div class="text-[11px] font-mono uppercase tracking-widest text-orange-400">How readability is costing you rankings</div>
        <ul id="linkList" class="mt-3 space-y-2 text-sm text-zinc-200"></ul>
      </div>

      <div>
        <div class="flex items-baseline justify-between gap-4 mb-4">
          <h2 class="text-xl font-bold">Fixes to ship today</h2>
          <div id="fixSummary" class="text-xs sm:text-sm font-mono text-zinc-400 text-right"></div>
        </div>
        <ul id="fixes" class="space-y-3"></ul>
        <div id="sideEffects" class="hidden mt-3"></div>
        <div id="allPass" class="hidden rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-emerald-300">No fixes needed. AI tools can read and find this page cleanly.</div>
      </div>

      <div class="grid lg:grid-cols-2 gap-4">
        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div class="flex items-center justify-between gap-2">
            <h3 class="font-semibold">Search visibility</h3>
            <span class="text-[11px] font-mono text-zinc-500 uppercase tracking-widest">TinyFish Search</span>
          </div>
          <div id="visDetail" class="mt-4 space-y-3 text-sm"></div>
        </div>
        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div class="flex items-center justify-between gap-2">
            <h3 class="font-semibold">Browser vs AI fetch</h3>
            <span class="text-[11px] font-mono text-zinc-500 uppercase tracking-widest">TinyFish Agent</span>
          </div>
          <div id="renderDetail" class="mt-4 space-y-2 text-sm"></div>
        </div>
      </div>

      <details class="rounded-2xl border border-zinc-800 bg-zinc-900/40">
        <summary class="cursor-pointer select-none px-5 py-4 text-sm font-semibold text-zinc-300 hover:text-white flex items-center justify-between">
          <span>Passed checks</span><span id="passCount" class="font-mono text-zinc-500 text-xs"></span>
        </summary>
        <ul id="passes" class="px-5 pb-5 space-y-2 text-sm"></ul>
      </details>
    </section>
  </main>

  <script>
    var $ = function (id) { return document.getElementById(id); };
    var state = null;
    var runId = 0;

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function tone(score) {
      if (score == null || isNaN(score)) return { hex: '#52525b', cls: 'text-zinc-400', label: '' };
      if (score >= 85) return { hex: '#34d399', cls: 'text-emerald-400', label: 'Excellent' };
      if (score >= 70) return { hex: '#a3e635', cls: 'text-lime-400', label: 'Good, with gaps' };
      if (score >= 55) return { hex: '#facc15', cls: 'text-yellow-400', label: 'Needs work' };
      if (score >= 40) return { hex: '#fb923c', cls: 'text-orange-400', label: 'Hard for AI to use' };
      return { hex: '#f87171', cls: 'text-red-400', label: 'Mostly invisible to AI' };
    }
    function grade(s) { return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F'; }
    function countUp(el, target) {
      var start = performance.now(), dur = 800;
      function tick(now) {
        var t = Math.min(1, (now - start) / dur);
        el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3)));
        if (t < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }
    async function api(path, opts) {
      var res = await fetch(path, opts);
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || data.ok === false) throw new Error(data.error || ('Request failed (' + res.status + ')'));
      return data;
    }

    // ---------- pipeline pills
    var STEPS = [
      { key: 'fetch', name: 'Fetch', what: 'reading page' },
      { key: 'search', name: 'Search', what: 'checking rankings' },
      { key: 'agent', name: 'Agent', what: 'opening real browser' }
    ];
    function renderPipeline() {
      $('pipeline').innerHTML = STEPS.map(function (s) {
        var st = state.steps[s.key];
        var dot = st === 'running' ? '<span class="w-3 h-3 rounded-full border-2 border-orange-400 border-t-transparent spin"></span>'
          : st === 'done' ? '<span class="text-emerald-400">✓</span>'
          : st === 'error' ? '<span class="text-red-400">✕</span>'
          : st === 'skipped' ? '<span class="text-zinc-600">–</span>'
          : '<span class="w-2 h-2 rounded-full bg-zinc-700"></span>';
        var sub = st === 'running' ? s.what : st === 'skipped' ? 'off' : st === 'error' ? 'failed' : st === 'done' ? 'done' : 'waiting';
        return '<span class="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/70 px-3 py-1.5 text-xs">' + dot +
          '<span class="font-semibold">' + s.name + '</span><span class="text-zinc-500">' + sub + '</span></span>';
      }).join('');
    }

    // ---------- metric cards
    function metricCard(id, title, value, sub, status) {
      var el = $(id);
      if (status === 'loading') {
        el.innerHTML = '<div class="h-full rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5"><div class="text-[11px] font-mono uppercase tracking-widest text-zinc-500">' + title +
          '</div><div class="mt-3 h-9 w-20 rounded-lg shimmer"></div><div class="mt-3 h-3 w-28 rounded shimmer"></div></div>';
        return;
      }
      var t = tone(value);
      var big = value == null ? '<span class="text-zinc-600">–</span>' : '<span class="' + t.cls + '">' + value + '</span><span class="text-base text-zinc-500 font-semibold">/100</span>';
      el.innerHTML = '<div class="h-full rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 fade-in"><div class="text-[11px] font-mono uppercase tracking-widest text-zinc-500">' + title +
        '</div><div class="mt-2 text-3xl font-extrabold tabular-nums">' + big + '</div><div class="mt-1.5 text-xs text-zinc-400 leading-snug">' + esc(sub || '') + '</div></div>';
    }

    function updateOverall() {
      var parts = [state.scores.read, state.scores.vis, state.scores.render].filter(function (x) { return typeof x === 'number'; });
      var ring = $('ring');
      if (!parts.length) { $('overall').textContent = '–'; $('overallGrade').textContent = ''; $('overallLabel').textContent = 'Analyzing…'; ring.style.strokeDashoffset = '97.4'; return; }
      var o = Math.round(parts.reduce(function (a, b) { return a + b; }, 0) / parts.length);
      var t = tone(o);
      countUp($('overall'), o);
      $('overallGrade').textContent = grade(o);
      $('overallGrade').className = 'text-2xl font-extrabold ' + t.cls;
      var pending = ['fetch', 'search', 'agent'].filter(function (k) { return state.steps[k] === 'running' || state.steps[k] === 'waiting'; }).length;
      $('overallLabel').textContent = pending ? 'Updating as checks finish…' : t.label;
      ring.style.stroke = t.hex;
      ring.style.strokeDashoffset = String(97.4 * (1 - o / 100));
    }

    // ---------- section renderers
    function renderAudit(a) {
      var r = a.ai_readability || {};
      var stats = r.stats || a.stats || {};
      var words = Number(stats.words || 0);
      state.scores.read = typeof r.score === 'number' ? r.score : null;
      var sub = words + ' words readable' + (words < 50 ? ' · almost nothing' : words < 300 ? ' · thin' : '');
      metricCard('card-read', 'AI readability', state.scores.read, sub);

      var u = a.ai_understanding && a.ai_understanding.what_this_page_is;
      $('understanding').classList.toggle('hidden', !u);
      if (u) $('understandingText').textContent = u;

      var checks = r.checks || a.checks || [];
      var passes = checks.filter(function (x) { return x.pass; });
      $('passCount').textContent = passes.length + '/' + checks.length;
      $('passes').innerHTML = passes.length ? passes.map(function (x) {
        return '<li class="flex gap-3"><span class="text-emerald-400 shrink-0">✓</span><span class="min-w-0 break-words"><span class="font-medium text-zinc-200">' +
          esc(x.label || x.id) + '</span> <span class="text-zinc-500">· ' + esc(x.detail) + '</span></span></li>';
      }).join('') : '<li class="text-zinc-500">None yet</li>';
    }

    var STATUS = {
      strong: ['Top 3', 'bg-emerald-500/15 text-emerald-300'],
      visible: ['Ranking', 'bg-lime-500/15 text-lime-300'],
      domain_only: ['Other page ranks', 'bg-yellow-500/15 text-yellow-300'],
      not_found: ['Not found', 'bg-red-500/15 text-red-300']
    };
    var SOURCE = { user: 'your query', page_title: 'from title', ai_predicted: 'AI-predicted' };

    function renderVis(v) {
      state.scores.vis = typeof v.visibility_score === 'number' ? v.visibility_score : null;
      var qs = (v.queries || []).filter(function (q) { return !q.error; });
      var found = qs.filter(function (q) { return q.status === 'strong' || q.status === 'visible'; }).length;
      metricCard('card-vis', 'Search visibility', state.scores.vis, 'Found for ' + found + ' of ' + qs.length + ' queries');

      $('visDetail').innerHTML = (v.queries || []).map(function (q) {
        if (q.error) return '<div class="rounded-xl border border-zinc-800 p-3 text-zinc-500">"' + esc(q.query) + '": search failed</div>';
        var s = STATUS[q.status] || ['?', 'bg-zinc-800 text-zinc-300'];
        var above = (q.outranked_by || []).slice(0, 3).map(function (o) { return esc(o.site || ''); }).join(', ');
        return '<div class="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">' +
          '<div class="flex items-start justify-between gap-3"><div class="min-w-0"><div class="font-medium text-zinc-100 break-words">' + esc(q.query) + '</div>' +
          '<div class="text-[11px] font-mono text-zinc-500 mt-0.5">' + esc(SOURCE[q.source] || q.source) + '</div></div>' +
          '<span class="shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ' + s[1] + '">' + (q.rank ? '#' + q.rank : s[0]) + '</span></div>' +
          (above ? '<div class="mt-2 text-xs text-zinc-400">' + (q.rank ? 'Above you: ' : 'Ranking instead: ') + above + '</div>' : '') +
          ((q.terms_missing_from_ai_readable_text || []).length ? '<div class="mt-1 text-xs text-orange-300">Missing from readable text: ' + esc(q.terms_missing_from_ai_readable_text.join(', ')) + '</div>' : '') +
          '</div>';
      }).join('') || '<div class="text-zinc-500">No queries checked.</div>';

      var links = v.readability_vs_visibility || [];
      $('linkBox').classList.toggle('hidden', !links.length);
      $('linkList').innerHTML = links.map(function (l) { return '<li class="flex gap-2"><span class="text-orange-400 shrink-0">→</span><span>' + esc(l) + '</span></li>'; }).join('');
    }

    function renderRender(r) {
      if (!r) { state.scores.render = null; metricCard('card-render', 'Render parity', null, 'Browser check off'); $('renderDetail').innerHTML = '<div class="text-zinc-500">Turn on "Real-browser check" to compare what visitors see with what AI tools read.</div>'; return; }
      if (r.blocked) {
        state.scores.render = 0;
        metricCard('card-render', 'Render parity', 0, 'Blocked for automated visitors');
        $('renderDetail').innerHTML = '<div class="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-red-300">Blocked: ' + esc(r.block_reason || 'captcha or login wall') + '</div>';
        return;
      }
      if (r.error || r.render_parity == null) {
        state.scores.render = null;
        metricCard('card-render', 'Render parity', null, 'Could not compare');
        $('renderDetail').innerHTML = '<div class="text-zinc-500">' + esc(r.error || 'The browser run returned no comparable content.') + '</div>';
        return;
      }
      state.scores.render = r.render_parity;
      var pts = r.content_points || [];
      var miss = pts.filter(function (p) { return !p.in_ai_fetch; }).length;
      metricCard('card-render', 'Render parity', r.render_parity, miss ? miss + ' of ' + pts.length + ' key items invisible to AI' : 'AI sees what visitors see');
      var bv = r.browser_view || {};
      $('renderDetail').innerHTML =
        (bv.main_heading ? '<div class="text-zinc-400">Visitors see: <span class="text-zinc-100 font-medium">' + esc(bv.main_heading) + '</span>' +
          (r.main_heading_in_ai_fetch === false ? ' <span class="text-red-300">(AI fetch misses this)</span>' : '') + '</div>' : '') +
        '<ul class="mt-2 space-y-1.5">' + pts.map(function (p) {
          return '<li class="flex gap-2.5"><span class="shrink-0 ' + (p.in_ai_fetch ? 'text-emerald-400">✓' : 'text-red-400">✕') + '</span><span class="break-words ' +
            (p.in_ai_fetch ? 'text-zinc-300' : 'text-zinc-100') + '">' + esc(p.visible_text) + '</span></li>';
        }).join('') + '</ul>' +
        ((bv.content_hidden_behind_interaction || []).length ? '<div class="mt-3 text-xs text-yellow-300">Hidden behind clicks: ' + esc(bv.content_hidden_behind_interaction.join('; ')) + '</div>' : '');
    }

    var AREA = {
      ai_readability: ['Readability', 'bg-sky-500/15 text-sky-300'],
      search_visibility: ['Search', 'bg-violet-500/15 text-violet-300'],
      js_rendering: ['Rendering', 'bg-pink-500/15 text-pink-300'],
      ai_understanding: ['AI understanding', 'bg-teal-500/15 text-teal-300'],
      access: ['Access', 'bg-red-500/15 text-red-300']
    };
    var PRIO = { high: 'bg-red-500/15 text-red-300', medium: 'bg-amber-500/15 text-amber-300', low: 'bg-zinc-800 text-zinc-400' };

    async function refreshFixes(myRun) {
      try {
        var d = await api('/api/fixes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audit: state.audit, visibility: state.vis, render: state.render })
        });
        if (myRun !== runId) return;
        var all = d.fixes || [];
        var main = all.filter(function (f) { return f.priority !== 'low'; });
        var side = all.filter(function (f) { return f.priority === 'low'; });
        var hi = main.filter(function (f) { return f.priority === 'high'; }).length;
        $('fixSummary').textContent = hi + ' high · ' + (main.length - hi) + ' medium';
        $('fixes').innerHTML = main.map(function (f, i) {
          var a = AREA[f.area] || [f.area, 'bg-zinc-800 text-zinc-300'];
          return '<li class="fade-in rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5" style="animation-delay:' + Math.min(i * 40, 400) + 'ms">' +
            '<div class="flex flex-wrap items-center gap-2">' +
              '<span class="rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ' + PRIO[f.priority] + '">' + f.priority + '</span>' +
              '<span class="rounded-md px-2 py-0.5 text-[11px] font-semibold ' + a[1] + '">' + a[0] + '</span>' +
              '<span class="font-semibold text-zinc-100">' + esc(f.issue) + '</span>' +
            '</div>' +
            (f.evidence ? '<p class="mt-2 text-sm text-zinc-400 break-words">' + esc(f.evidence) + '</p>' : '') +
            '<div class="mt-3 rounded-xl border border-orange-500/20 bg-orange-500/[0.05] px-4 py-3">' +
              '<div class="text-[10px] font-mono uppercase tracking-widest text-orange-400">Fix</div>' +
              '<div class="mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-zinc-200">' + esc(f.fix) + '</div>' +
            '</div></li>';
        }).join('');
        $('sideEffects').classList.toggle('hidden', !side.length);
        $('sideEffects').innerHTML = side.length ? '<div class="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">' +
          '<div class="text-xs text-zinc-400"><span class="font-semibold text-zinc-300">Also failing, caused by the missing content above:</span> ' +
          side.map(function (f) { return esc(f.issue); }).join(' · ') + '</div></div>' : '';
        var stillRunning = ['fetch', 'search', 'agent'].some(function (k) { return state.steps[k] === 'running' || state.steps[k] === 'waiting'; });
        $('allPass').classList.toggle('hidden', all.length > 0 || stillRunning);
      } catch (e) { /* keep last good list */ }
    }

    function setLoading(on) {
      $('btn').disabled = on;
      $('spinner').classList.toggle('hidden', !on);
      $('btnText').textContent = on ? 'Analyzing…' : 'Analyze Site';
    }
    function showError(msg) { $('error').textContent = msg; $('error').classList.remove('hidden'); }

    $('form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var url = $('url').value.trim();
      var query = $('query').value.trim();
      var useAgent = $('useAgent').checked;
      $('error').classList.add('hidden');
      if (!url) { showError('Enter a URL to audit.'); $('url').focus(); return; }

      var myRun = ++runId;
      state = { audit: null, vis: null, render: null, scores: {}, steps: { fetch: 'running', search: 'waiting', agent: useAgent ? 'running' : 'skipped' } };
      setLoading(true);
      $('results').classList.remove('hidden');
      $('auditedUrl').textContent = 'Auditing: ' + url;
      ['fixes', 'visDetail', 'renderDetail', 'passes', 'linkList', 'sideEffects'].forEach(function (id) { $(id).innerHTML = ''; });
      ['understanding', 'linkBox', 'allPass', 'sideEffects'].forEach(function (id) { $(id).classList.add('hidden'); });
      $('fixSummary').textContent = '';
      $('fixes').innerHTML = '<li class="h-24 rounded-2xl shimmer"></li><li class="h-24 rounded-2xl shimmer"></li>';
      $('visDetail').innerHTML = '<div class="h-16 rounded-xl shimmer"></div><div class="h-16 rounded-xl shimmer"></div>';
      $('renderDetail').innerHTML = useAgent ? '<div class="h-4 w-2/3 rounded shimmer"></div><div class="h-4 w-1/2 rounded shimmer"></div><div class="h-4 w-3/5 rounded shimmer"></div>' : '';
      metricCard('card-read', 'AI readability', null, '', 'loading');
      metricCard('card-vis', 'Search visibility', null, '', 'loading');
      if (useAgent) metricCard('card-render', 'Render parity', null, '', 'loading'); else renderRender(null);
      renderPipeline();
      updateOverall();

      var enc = encodeURIComponent(url);

      var agentTask = !useAgent ? Promise.resolve() : api('/api/render-gap?url=' + enc).then(function (r) {
        if (myRun !== runId) return;
        state.render = r; state.steps.agent = 'done';
        renderRender(r);
      }).catch(function (err) {
        if (myRun !== runId) return;
        state.steps.agent = 'error';
        renderRender({ error: 'Browser check failed: ' + err.message });
      }).then(function () { if (myRun === runId) { renderPipeline(); updateOverall(); refreshFixes(myRun); } });

      var mainTask = api('/api/fetch-audit?url=' + enc).then(function (a) {
        if (myRun !== runId) return;
        state.audit = a; state.steps.fetch = 'done'; state.steps.search = 'running';
        $('auditedUrl').textContent = 'Audited: ' + (a.final_url || url);
        renderAudit(a); renderPipeline(); updateOverall(); refreshFixes(myRun);

        var predicted = (a.ai_understanding && a.ai_understanding.search_queries_it_should_rank_for) || [];
        var qs = '/api/visibility-gap?url=' + enc + (query ? '&query=' + encodeURIComponent(query) : '') +
          (predicted.length ? '&extra_queries=' + encodeURIComponent(predicted.slice(0, 2).join('|')) : '');
        return api(qs).then(function (v) {
          if (myRun !== runId) return;
          state.vis = v; state.steps.search = 'done';
          renderVis(v);
        }).catch(function (err) {
          if (myRun !== runId) return;
          state.steps.search = 'error';
          metricCard('card-vis', 'Search visibility', null, 'Search failed');
          $('visDetail').innerHTML = '<div class="text-red-300">' + esc(err.message) + '</div>';
        }).then(function () { if (myRun === runId) { renderPipeline(); updateOverall(); refreshFixes(myRun); } });
      }).catch(function (err) {
        if (myRun !== runId) return;
        state.steps.fetch = 'error'; state.steps.search = 'skipped';
        showError('Could not read the page: ' + err.message);
        metricCard('card-read', 'AI readability', null, 'Fetch failed');
        metricCard('card-vis', 'Search visibility', null, 'Needs the page first');
        $('fixes').innerHTML = ''; $('visDetail').innerHTML = '';
        renderPipeline(); updateOverall();
      });

      await Promise.all([mainTask, agentTask]);
      if (myRun === runId) setLoading(false);
    });
  </script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});


app.listen(PORT, () => console.log(`SEO Page Auditor running on http://localhost:${PORT}  (LLM ${LLM_KEY ? 'on' : 'off'})`));
