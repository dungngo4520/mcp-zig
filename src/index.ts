#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

// LSP Message types
interface LSPRequest {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params?: any;
}

interface LSPResponse {
    jsonrpc: "2.0";
    id: number;
    result?: any;
    error?: any;
}

interface LSPNotification {
    jsonrpc: "2.0";
    method: string;
    params?: any;
}

class ZigLSPClient {
    private zlsProcess: ChildProcess | null = null;
    private messageId = 0;
    private pendingRequests = new Map<number, {
        resolve: (value: any) => void;
        reject: (error: any) => void;
    }>();
    private buffer = "";
    private initialized = false;

    async start(workspaceRoot: string): Promise<void> {
        console.error("Starting zls...");

        this.zlsProcess = spawn("zls", [], {
            cwd: workspaceRoot,
            stdio: ["pipe", "pipe", "pipe"],
        });

        if (!this.zlsProcess.stdout || !this.zlsProcess.stdin) {
            throw new Error("Failed to create zls process");
        }

        this.zlsProcess.stdout.on("data", (data: Buffer) => {
            this.handleData(data);
        });

        this.zlsProcess.stderr?.on("data", (data: Buffer) => {
            console.error("zls stderr:", data.toString());
        });

        this.zlsProcess.on("error", (error) => {
            console.error("zls process error:", error);
        });

        // Initialize LSP
        await this.initialize(workspaceRoot);
        this.initialized = true;
    }

    private handleData(data: Buffer): void {
        this.buffer += data.toString();

        while (true) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) break;

            const header = this.buffer.substring(0, headerEnd);
            const contentLengthMatch = header.match(/Content-Length: (\d+)/);

            if (!contentLengthMatch) break;

            const contentLength = parseInt(contentLengthMatch[1]);
            const messageStart = headerEnd + 4;

            if (this.buffer.length < messageStart + contentLength) break;

            const messageContent = this.buffer.substring(
                messageStart,
                messageStart + contentLength
            );
            this.buffer = this.buffer.substring(messageStart + contentLength);

            try {
                const message = JSON.parse(messageContent);
                this.handleMessage(message);
            } catch (error) {
                console.error("Failed to parse LSP message:", error);
            }
        }
    }

    private handleMessage(message: LSPResponse | LSPNotification): void {
        if ("id" in message) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                if (message.error) {
                    pending.reject(message.error);
                } else {
                    pending.resolve(message.result);
                }
                this.pendingRequests.delete(message.id);
            }
        }
    }

    private async sendRequest(method: string, params?: any): Promise<any> {
        if (!this.zlsProcess?.stdin) {
            throw new Error("zls process not started");
        }

        const id = this.messageId++;
        const request: LSPRequest = {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };

        const content = JSON.stringify(request);
        const message = `Content-Length: ${content.length}\r\n\r\n${content}`;

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.zlsProcess!.stdin!.write(message);

            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error("Request timeout"));
                }
            }, 30000);
        });
    }

    private sendNotification(method: string, params?: any): void {
        if (!this.zlsProcess?.stdin) return;

        const notification: LSPNotification = {
            jsonrpc: "2.0",
            method,
            params,
        };

        const content = JSON.stringify(notification);
        const message = `Content-Length: ${content.length}\r\n\r\n${content}`;
        this.zlsProcess.stdin.write(message);
    }

    private async initialize(workspaceRoot: string): Promise<void> {
        const result = await this.sendRequest("initialize", {
            processId: process.pid,
            rootUri: `file://${workspaceRoot}`,
            capabilities: {
                textDocument: {
                    completion: {
                        completionItem: {
                            snippetSupport: true,
                        },
                    },
                    hover: {
                        contentFormat: ["markdown", "plaintext"],
                    },
                    definition: {
                        linkSupport: true,
                    },
                    references: {},
                    documentSymbol: {},
                },
                workspace: {
                    workspaceFolders: true,
                },
            },
        });

        this.sendNotification("initialized", {});
        console.error("zls initialized:", result);
    }

    async openDocument(uri: string, content: string): Promise<void> {
        this.sendNotification("textDocument/didOpen", {
            textDocument: {
                uri,
                languageId: "zig",
                version: 1,
                text: content,
            },
        });
    }

    async getCompletions(uri: string, line: number, character: number): Promise<any> {
        return await this.sendRequest("textDocument/completion", {
            textDocument: { uri },
            position: { line, character },
        });
    }

    async getHover(uri: string, line: number, character: number): Promise<any> {
        return await this.sendRequest("textDocument/hover", {
            textDocument: { uri },
            position: { line, character },
        });
    }

    async getDefinition(uri: string, line: number, character: number): Promise<any> {
        return await this.sendRequest("textDocument/definition", {
            textDocument: { uri },
            position: { line, character },
        });
    }

    async getReferences(uri: string, line: number, character: number): Promise<any> {
        return await this.sendRequest("textDocument/references", {
            textDocument: { uri },
            position: { line, character },
            context: { includeDeclaration: true },
        });
    }

    stop(): void {
        if (this.zlsProcess) {
            this.zlsProcess.kill();
            this.zlsProcess = null;
        }
    }
}

// Tool definitions
const tools: Tool[] = [
    {
        name: "zig_complete",
        description: "Get code completions for Zig at a specific position. Returns suggestions for variables, functions, types, etc.",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Absolute path to the Zig file",
                },
                content: {
                    type: "string",
                    description: "Current content of the file",
                },
                line: {
                    type: "number",
                    description: "Line number (0-indexed)",
                },
                character: {
                    type: "number",
                    description: "Character position in line (0-indexed)",
                },
            },
            required: ["file_path", "content", "line", "character"],
        },
    },
    {
        name: "zig_hover",
        description: "Get hover information (documentation, type info) for a symbol at a specific position in Zig code",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Absolute path to the Zig file",
                },
                content: {
                    type: "string",
                    description: "Current content of the file",
                },
                line: {
                    type: "number",
                    description: "Line number (0-indexed)",
                },
                character: {
                    type: "number",
                    description: "Character position in line (0-indexed)",
                },
            },
            required: ["file_path", "content", "line", "character"],
        },
    },
    {
        name: "zig_goto_definition",
        description: "Find the definition location of a symbol in Zig code",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Absolute path to the Zig file",
                },
                content: {
                    type: "string",
                    description: "Current content of the file",
                },
                line: {
                    type: "number",
                    description: "Line number (0-indexed)",
                },
                character: {
                    type: "number",
                    description: "Character position in line (0-indexed)",
                },
            },
            required: ["file_path", "content", "line", "character"],
        },
    },
    {
        name: "zig_find_references",
        description: "Find all references to a symbol in the Zig workspace",
        inputSchema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "Absolute path to the Zig file",
                },
                content: {
                    type: "string",
                    description: "Current content of the file",
                },
                line: {
                    type: "number",
                    description: "Line number (0-indexed)",
                },
                character: {
                    type: "number",
                    description: "Character position in line (0-indexed)",
                },
            },
            required: ["file_path", "content", "line", "character"],
        },
    },
];

async function main() {
    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
    console.error("Workspace root:", workspaceRoot);

    const lspClient = new ZigLSPClient();
    await lspClient.start(workspaceRoot);

    const server = new Server(
        {
            name: "mcp-zig",
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools,
    }));

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        try {
            const { file_path, content, line, character } = args as any;
            const uri = `file://${file_path}`;

            // Open document in zls
            await lspClient.openDocument(uri, content);

            switch (name) {
                case "zig_complete": {
                    const result = await lspClient.getCompletions(uri, line, character);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result, null, 2),
                            },
                        ],
                    };
                }

                case "zig_hover": {
                    const result = await lspClient.getHover(uri, line, character);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result, null, 2),
                            },
                        ],
                    };
                }

                case "zig_goto_definition": {
                    const result = await lspClient.getDefinition(uri, line, character);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result, null, 2),
                            },
                        ],
                    };
                }

                case "zig_find_references": {
                    const result = await lspClient.getReferences(uri, line, character);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result, null, 2),
                            },
                        ],
                    };
                }

                default:
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Unknown tool: ${name}`,
                            },
                        ],
                        isError: true,
                    };
            }
        } catch (error: any) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${error.message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    // Start server
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error("MCP Zig server running on stdio");

    // Cleanup on exit
    process.on("SIGINT", () => {
        lspClient.stop();
        process.exit(0);
    });
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
