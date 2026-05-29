# aurixel-mcp

An [MCP](https://modelcontextprotocol.io) server that lets MCP hosts
(Claude Desktop, Cursor, Cline, …) generate images through
**Aurixel** (joyviz.ai). It exposes Aurixel's image models — e.g.
`gpt-image-2` — as a tool, so you can just ask your assistant to draw
something and get the picture back inline.

## Tools

| Tool | What it does |
|------|--------------|
| `generate_image(prompt, model?, size?)` | Generate an image from a text prompt; returns it inline. |
| `list_image_models()` | List the image models you can pass to `generate_image`. |

## Setup

1. Get a `ck-…` API key at <https://app.joyviz.ai/app/keys>.
2. Add the server to your MCP host config.

**Claude Desktop** (`claude_desktop_config.json`) / **Cursor**
(`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "aurixel": {
      "command": "npx",
      "args": ["-y", "github:bifrost-studio/aurixel-mcp"],
      "env": { "AURIXEL_API_KEY": "ck-your-key-here" }
    }
  }
}
```

Restart the host, then ask it to "draw a watercolor fox" — it'll call
`generate_image` and show the picture.

## Config (env)

| Var | Required | Default |
|-----|----------|---------|
| `AURIXEL_API_KEY` | ✅ | — |
| `AURIXEL_BASE_URL` | | `https://conduit-api.joyviz.ai` |
| `AURIXEL_IMAGE_MODEL` | | `gpt-image-2` |

## Notes

- Transport: stdio (standard for locally-run MCP servers).
- Billing follows your Aurixel account — each image is charged to the
  key you configure.
