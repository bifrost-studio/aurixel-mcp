# aurixel-mcp

An [MCP](https://modelcontextprotocol.io) server that lets MCP hosts
(Claude Desktop, Cursor, Cline, …) generate images through
**Aurixel** (joyviz.ai). It exposes Aurixel's image models — e.g.
`gpt-image-2` — as tools, so you can just ask your assistant to draw
something and get the picture back.

## Tools

| Tool | What it does |
|------|--------------|
| `generate_image(prompt, model?, size?)` | Start a generation. Returns a `job_id` **immediately** (the image runs in the background). |
| `get_image_result(job_id)` | Fetch the finished image. If it's still generating, returns a "still generating" message — call again with the same `job_id`. |
| `list_image_models()` | List the image models you can pass to `generate_image`. |

### Why a job + poll instead of returning the image inline?

`gpt-image-2` takes **60–120s+**, but MCP hosts cancel any single tool
call at a fixed ~60s timeout that progress notifications don't reliably
reset. So a long generation returned inline gets killed (and billed)
mid-flight. Instead, `generate_image` returns instantly and the host
polls `get_image_result` — each poll waits ≤30s, comfortably under the
host's limit, so generations of any length come through. No host-side
timeout tweak required. The assistant drives the polling for you; you
just ask for a picture and the image arrives when it's ready.

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
`generate_image`, poll `get_image_result` while the image renders, and
show the picture once it's ready.

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
