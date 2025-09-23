# Repository Guidelines

## Project Structure & Module Organization
- `ChatGPT2Notion.js` houses the complete Tampermonkey user script, split by banner comments for utilities, Notion client calls, and DOM integration.
- `README.md` is the bilingual quick start for contributors and users; update it whenever the script UI or setup flow changes.
- No other modules or assets exist; keep temporary experiments out of the repository.

## Build, Test, and Development Commands
- `node --check ChatGPT2Notion.js` verifies the script parses before you paste it into Tampermonkey.
- `npx eslint ChatGPT2Notion.js` (after `npm install eslint`) catches unused variables and stray globals.
- `npx prettier --write ChatGPT2Notion.js` keeps spacing consistent after large edits; rerun manual UI checks afterward.

## Coding Style & Naming Conventions
- Stick to 2-space indentation, single quotes, and semicolons where the linter would require them.
- Use upper-snake for immutable constants (`NOTION_API`) and lowerCamelCase for helpers, DOM nodes, and flags.
- Preserve the existing `// ===== Section =====` banners to keep Tampermonkey’s editor navigable and update titles when you move logic.

## Testing Guidelines
- Perform manual verification in Chrome/Edge with Tampermonkey: reinstall the script, reload chatgpt.com, and ensure both toolbar buttons render beneath assistant messages.
- Exercise both Notion flows—creating a new page (page and database parents) and appending to an existing block—to confirm configuration toggles still align with expectations.
- Validate math preservation by prompting ChatGPT for LaTeX and confirming the Notion page renders inline and block equations.

## Commit & Pull Request Guidelines
- Follow the short, imperative commit pattern seen in history (e.g., `Update ChatGPT2Notion.js`) and group localization edits with the behavior they modify.
- PR descriptions should summarize user-facing impact, list manual test steps, and link related issues or discussions.
- Attach before/after screenshots for UI adjustments and call out new settings so reviewers can test them quickly.

## Security & Configuration Tips
- Never commit personal Notion tokens or workspace URLs; redact them in examples and screenshots.
- Document new `GM_*` permissions in the header block and explain their purpose in the PR body.
- Treat the `NOTION_VERSION` constant as immutable unless you have verified compatibility against Notion’s changelog in a separate validation pass.
