<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/nuviomcp-wordmark-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="assets/nuviomcp-wordmark-light.png" />
    <img src="assets/nuviomcp-wordmark-light.png" alt="Nuvio MCP" width="400" />
  </picture>

  <p>
    <strong>An unofficial MCP server for managing your Nuvio account from AI clients.</strong><br />
    Profiles · Addons · Plugins · Settings · Collections · Library · Providers · Trackers
  </p>

  <p>
    <a href="https://github.com/wiktorekdev/nuvio-mcp/actions/workflows/ci.yml"><img src="https://github.com/wiktorekdev/nuvio-mcp/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://www.npmjs.com/package/nuvio-mcp"><img src="https://img.shields.io/npm/v/nuvio-mcp?style=flat&color=6366f1&logo=npm&logoColor=white" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/nuvio-mcp"><img src="https://img.shields.io/npm/dm/nuvio-mcp?style=flat&color=6366f1&logo=npm&logoColor=white" alt="npm downloads" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-server-6366f1?style=flat" alt="MCP" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat&logo=node.js&logoColor=white" alt="Node" />
    <a href="LICENSE"><img src="https://img.shields.io/github/license/wiktorekdev/nuvio-mcp?style=flat&color=6366f1&cacheSeconds=3600" alt="License" /></a>
  </p>

  <p>
    <em>Unofficial community project. Not affiliated with or endorsed by Nuvio.</em>
  </p>

</div>

---

## Features

- Manage profiles, addons and plugins
- Update TV, mobile and desktop settings
- Manage collections, library, watch progress and history
- Manage provider credentials and trackers
- Export backups
- Undo and redo reversible changes
- Two-step confirmation for irreversible operations
- stdio and remote Streamable HTTP

`nuvio_capabilities` lists every tool at runtime.

## Installation

Add it to your MCP clients with [add-mcp](https://add-mcp.com):

```bash
npx add-mcp nuvio-mcp -g \
  --env "NUVIO_EMAIL=you@example.com" \
  --env "NUVIO_PASSWORD=your-password"
```

Run the server directly over stdio:

```bash
npx -y nuvio-mcp
```

From source:

```bash
git clone https://github.com/wiktorekdev/nuvio-mcp
cd nuvio-mcp
npm ci
npm run build
cp .env.example .env
node dist/index.js
```

## Configuration

| Variable              | Description                        |
| --------------------- | ---------------------------------- |
| `NUVIO_EMAIL`         | Nuvio account email                |
| `NUVIO_PASSWORD`      | Nuvio account password             |
| `NUVIO_REFRESH_TOKEN` | Alternative to email/password      |
| `NUVIO_TRANSPORT`     | `stdio` (default) or `http`        |
| `NUVIO_HTTP_TOKEN`    | Bearer token for the HTTP endpoint |

See [`.env.example`](.env.example) for all options.

## Remote MCP

```bash
NUVIO_TRANSPORT=http \
NUVIO_HTTP_HOST=0.0.0.0 \
NUVIO_HTTP_PORT=3333 \
NUVIO_HTTP_TOKEN="$(openssl rand -hex 32)" \
npx -y nuvio-mcp
```

- Streamable HTTP endpoint: `POST /mcp`
- Health: `GET /health`
- Bearer token, or OAuth introspection when configured
- A non-loopback bind requires authentication

Docker:

```bash
docker build -t nuvio-mcp .
docker run --rm -p 3333:3333 \
  -e NUVIO_EMAIL=you@example.com \
  -e NUVIO_PASSWORD=your-password \
  -e NUVIO_HTTP_TOKEN=change-me \
  -v nuvio-mcp-data:/data \
  nuvio-mcp
```

## Safety

- Reversible mutations create a snapshot before they run
- Undo and redo via `nuvio_undo` and `nuvio_redo`
- Irreversible operations use two-step confirmation
- Secrets are masked from MCP outputs
- Sensitive snapshots may contain raw credentials locally, for exact undo

Set `NUVIO_DISABLE_SNAPSHOTS=true` to never write snapshots locally: reversible changes then run
without snapshots and cannot be undone, and no raw credentials are stored on disk.

See [SECURITY.md](SECURITY.md) for the security model.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
bash test/docker-smoke.sh
```

## License

[MIT](LICENSE)
