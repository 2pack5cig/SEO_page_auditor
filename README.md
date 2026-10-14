# DTU SEO Page Auditor (TinyFish)

Enter any URL (and optionally a search query). The app reports what AI tools can and can't read, where the page
ranks, and a prioritized list of concrete fixes.

## Run
```
npm install
copy .env.example .env     # then add TINYFISH_API_KEY (Mac/Linux: cp .env.example .env)
npm start                  # http://localhost:3000
```

## How TinyFish is used
- **Fetch**: reads the live page (ttl 0) as an AI tool would: markdown text, metadata, links. Also reads robots.txt and llms.txt in the same call.
- **Search**: runs the user's query, the page title, and AI-predicted queries; finds the page's rank and which competitors outrank it.
- **Agent**: opens the page in a real browser and records what a visitor sees; compared with Fetch output to find content AI tools miss (JS-rendered, tabs, accordions).
Findings link readability to visibility: query terms missing from AI-readable text are flagged next to the queries the page fails to rank for.
