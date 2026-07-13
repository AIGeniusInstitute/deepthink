# Security Notes

## `yaml` parser trust boundary

`yaml` (npm package) is used in `src/plugin-command-index.ts:39` to parse
plugin command frontmatter. This is a **trusted parser path**:

- Frontmatter content originates from plugin trees in the shared catalog
  (catalog target dir: `data/plugins/catalog/marketplaces/{mp}/plugins/{plugin}/versions/...`;
   scan source dir is described below)
- The catalog is populated by the backend's `scanHostMarketplaces()`
  (`src/plugin-importer.ts`), which is invoked from three places:
  - server startup (5s after boot, when `pluginAutoScan` is true)
  - hourly periodic timer (same `pluginAutoScan` gate)
  - the manual `POST /api/plugins/catalog/scan` endpoint, which is
    **admin-only** (`src/routes/plugins.ts` checks `authUser.role !== 'admin'`)
- Scan source root is `getEffectiveExternalDir() + /plugins/marketplaces`
  (defaults to `~/.claude/plugins/marketplaces`, configurable via
  `SystemSettings.externalClaudeDir`); member users cannot influence what
  becomes available system-wide.

`yaml` is **NOT** used to parse user-supplied input from:

- Web UI request bodies
- IM channel messages (Feishu, Telegram, QQ, DingTalk, Discord)
- Any HTTP API request body

If a future code path adds user-supplied YAML parsing, that path must be
reviewed independently — admit-time safety of the parser version installed
today is not a license to expose it to untrusted input later.
