# Patchbay

Small web client that lets Claude use tools from several remote MCP servers in one chat.

Anthropic’s API talks to the MCP servers directly. Your API key never leaves the server.

## Quick start

```bash
cp .env.example .env
# put your ANTHROPIC_API_KEY in .env
npm install
npm start
```

Open http://127.0.0.1:3000

## Important notes

- **MCP tokens** are stored in the browser’s `localStorage`. Only use trusted machines.
- Server defaults to `127.0.0.1`. If you expose it on a network, set `APP_PASSWORD`.
- Only models listed in `MODELS` (env) are accepted by the server.
- Only `https://` MCP server URLs are allowed.

## Environment

See `.env.example`.

## Security

- API key stays on the server
- Strict CSP
- Optional shared password (timing-safe compare)
- Rate limiting on chat and password check
- Model allowlist enforced server-side
