# MCP Zig Server

MCP server providing Zig language features (completions, hover info, definitions, references) via integration with the Zig Language Server (zls).

Works with any MCP-compatible client: AI assistants, IDEs, or coding agents that support the Model Context Protocol.

## Quick Setup

### 1. Install zls

```bash
# macOS/Linux
brew install zls

# Windows
scoop install zls

# Or download binary: https://github.com/zigtools/zls/releases
```

### 2. Configure Your MCP Client

Add to your MCP settings file:

```json
{
  "mcpServers": {
    "mcp-zig": {
      "command": "npx",
      "args": ["-y", "@dungngo4520/mcp-zig"],
      "env": {
        "WORKSPACE_ROOT": "/path/to/your/zig/project"
      }
    }
  }
}
```

**Common config locations:**

- **macOS:** `~/Library/Application Support/<client>/config.json`
- **Windows:** `%APPDATA%\<client>\config.json`
- **Linux:** `~/.config/<client>/config.json`

Replace `<client>` with your MCP client's name. Check your client's documentation for exact path.

### 3. Restart Your MCP Client

You'll have access to 4 new tools:

- `zig_complete` - Code completions
- `zig_hover` - Symbol information
- `zig_goto_definition` - Jump to definitions
- `zig_find_references` - Find all usages

## Usage

Ask natural language questions about your Zig code:

- "What does this function do?"
- "Show me completions here"
- "Where is this defined?"
- "Find all usages of this symbol"

Your AI assistant automatically chooses the right tool.

## Troubleshooting

**Tools not showing up?**

- Verify `zls` is installed: `zls --version`
- Check the config file path for your MCP client
- Restart your MCP client after config changes
- Make sure `WORKSPACE_ROOT` points to a valid Zig project

## Contributing

```bash
git clone https://github.com/dungngo4520/mcp-zig.git
cd mcp-zig
npm install
npm run build
```

## License

MIT
