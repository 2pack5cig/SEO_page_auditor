# DTU SEO Page Auditor (TinyFish)

Enter any URL (and optionally a search query). The app reports what AI tools can and can't read, where the page
ranks, and a prioritized list of concrete fixes.

## Run
```
npm install
copy .env.example .env     # then add TINYFISH_API_KEY (Mac/Linux: cp .env.example .env)
npm start                  # http://localhost:3000
```

# AI Readability Auditor

**Can AI actually read your page?**

More people now find websites through AI tools such as ChatGPT, Perplexity and Google's AI answers. Many pages that look fine to humans are nearly invisible to these tools, because their content loads through JavaScript or isn't structured in a way AI can use. Site owners usually have no idea.

This tool takes any live URL (and optionally a target search query) and shows how AI tools see the page, whether it shows up in search, and exactly what to fix today.

Built for the **TinyFish × DTU workshop: SEO Page Auditor** bounty.

---

## How TinyFish is used

| TinyFish endpoint | What it does in this tool |
|---|---|
| **Fetch** | Reads the live page, its `robots.txt` and its `llms.txt` in one call, exactly as an AI tool would. The readability score comes from what Fetch actually extracts: readable word count, headings and structure, metadata, and whether AI crawlers are blocked. |
| **Search** | Checks where the page ranks for the target query, for its own title, and for the queries an LLM predicts it should rank for. Shows which sites outrank it and which query terms are missing from the readable text. |
| **Agent** | Opens the page in a real browser and records what a visitor sees. Comparing that with the Fetch output reveals content that exists for humans but is invisible to AI tools. |

The report connects the three: content that AI tools can't read is often the reason a page doesn't rank for the terms it should.

All audits run on live pages. Fetch is called with `ttl: 0`, so nothing is served from cache.

---

## What the report shows

- **Four scores:** overall, AI readability, search visibility, and render parity (how much of what visitors see, AI tools can also read).
- **What an AI thinks the page is about**, based only on the text Fetch extracted (requires an LLM key).
- **How readability is costing rankings**, e.g. *"Not ranking for 'watch videos online', and AI tools reading this page never see 'watch' or 'online'."*
- **Prioritized fixes**, each with evidence from the page itself rather than generic SEO tips. Failures that are side effects of a root cause (such as missing headings on a page whose content isn't readable at all) are grouped under that root cause.
- **Search panel:** rank per query and who outranks the page.
- **Browser vs AI fetch panel:** each key item a visitor sees, marked as readable or invisible to AI.

### Readability checks

Readable content · page title · meta description · heading structure · single H1 · chunk-friendly paragraphs · lists and tables · canonical URL · indexable (no `noindex`) · AI crawlers allowed in `robots.txt` (GPTBot, ClaudeBot, PerplexityBot, Google-Extended and others) · `llms.txt` present

---

## Setup

Requires **Node.js 18+**.

```bash
npm init -y
npm install express
```

Create a `.env` file (and add it to `.gitignore`):

```bash
TINYFISH_API_KEY=your_tinyfish_key

# Optional: any OpenAI-compatible LLM, used for "what AI thinks this page is"
# and AI-predicted search queries. Example with Groq's free tier:
LLM_API_KEY=your_llm_key
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile

# Optional: country for search results
# SEARCH_LOCATION=IN
```

Run (Node 20.6+ reads `.env` directly):

```bash
node --env-file=.env server.js
```

On Node 18, export the variables in your shell instead, then run `node server.js`.

Open **http://localhost:3000**, enter a URL, and click **Analyze Site**.

Untick **Real-browser check** for faster runs. The Agent check takes 30–60 seconds and is billed from your TinyFish wallet.

---

## API

All routes accept GET query parameters or a POST JSON body.

| Route | TinyFish used | Returns |
|---|---|---|
| `GET /api/fetch-audit?url=` | Fetch | AI readability score, checks, robots.txt and llms.txt status, LLM understanding |
| `GET /api/visibility-gap?url=&query=` | Search, Fetch | Rank per query, sites outranking the page, missing query terms |
| `GET /api/render-gap?url=` | Agent, Fetch | Content visible in a browser but missing from AI fetch |
| `GET /api/final-report?url=&query=&render=true` | Fetch, Search, Agent | All of the above plus a prioritized fix list |
| `POST /api/fixes` | none | Builds the merged fix list from the three results above |
| `GET /api` | none | Route index |

Example:

```bash
curl "http://localhost:3000/api/final-report?url=https://example.com&query=example+domain"
```

---

## Demo

<!-- Replace with your recording and screenshots. Blur anything personal. -->

| Page | What the audit found |
|---|---|
| `youtube.com` | _e.g. AI fetch reads ~20 words; most visible content is loaded by JavaScript_ |
| _a Wikipedia article_ | _e.g. high readability, strong structure_ |
| _a small business or college site_ | _your findings_ |
| _a page + target query where it doesn't rank_ | _your findings_ |

---

## Tech

- Node.js + Express, single file (`server.js`)
- Tailwind CSS (CDN) for the dashboard
- TinyFish Fetch, Search and Agent REST APIs
- Optional OpenAI-compatible LLM
