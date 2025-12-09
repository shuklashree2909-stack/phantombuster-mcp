import "dotenv/config";
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import axios from "axios";
import { getPhantombusterApiKey, getPhantombusterBaseUrl } from "./tools/phantombusterAuth";
import { requestContext } from "./context";

// -------------------
// Config & helpers
// -------------------

const PH_API_KEY = getPhantombusterApiKey();
const PH_BASE_URL = getPhantombusterBaseUrl();

const server = new McpServer(
    {
        name: "phantombuster-mcp-server",
        version: "0.1.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

function pretty(obj: unknown): string {
    return JSON.stringify(obj, null, 2);
}

function errorContent(message: string) {
    return {
        content: [
            {
                type: "text" as const,
                text: `Error: ${message}`,
            },
        ],
    };
}

// Generic request helper to Phantombuster
async function phRequest<T = any>(
    method: "GET" | "POST",
    path: string,
    body?: any,
    params?: Record<string, any>
): Promise<T> {
    try {
        const ctx = requestContext.getStore();
        const apiKey = ctx?.externalApiKey;
        console.log("apiKey", apiKey);

        if (!apiKey) {
            throw new Error(
                "No API key provided. Send 'Authorization: Bearer YOUR_PHANTOMBUSTER_KEY' in the MCP HTTP request."
            );
        }
        const url = `${PH_BASE_URL}${path}`;
        const res = await axios.request<T>({
            method,
            url,
            headers: {
                "X-Phantombuster-Key-1": apiKey,
                "Content-Type": "application/json",
            },
            data: body,
            params,
            timeout: 60_000,
        });
        return res.data;
    } catch (err: any) {
        console.error("Phantombuster API error", err?.response?.data || err?.message || err);
        const msg =
            err?.response?.data?.error ||
            err?.response?.data?.message ||
            err?.message ||
            "Unknown Phantombuster API error";
        throw new Error(msg);
    }
}

// -------------------
// Tools
// -------------------

/**
 * Launch a Phantom by ID with optional arguments.
 * Typically mapped to POST /agents/launch or similar.
 */
server.registerTool(
    "phantom_launch",
    {
        description:
            "Launch a Phantombuster Phantom by its ID with optional arguments (input). Returns launch information.",
        inputSchema: z.object({
            agentId: z.string().describe("Phantom/agent ID from Phantombuster dashboard"),
            argument: z.record(z.any()).optional().describe("Phantom input configuration (object passed as argument)"),
            manual: z.boolean().optional().default(false).describe("If true, launches in manual mode (depends on Phantom settings)"),
        }),
    },
    async (input: any) => {
        try {
            const parsed = z
                .object({
                    agentId: z.string(),
                    argument: z.record(z.any()).optional(),
                    manual: z.boolean().optional().default(false),
                })
                .parse(input);

            // Endpoint is often something like /agents/launch
            // For some setups, it might be /agents/launch?id=<id>
            const data = await phRequest<any>("POST", "/agents/launch", {
                id: parsed.agentId,
                argument: parsed.argument ?? {},
                manual: parsed.manual,
            });

            return {
                content: [
                    {
                        type: "text",
                        text: pretty({
                            action: "launch",
                            agentId: parsed.agentId,
                            response: data,
                        }),
                    },
                ],
            };
        } catch (err: any) {
            return errorContent(err?.message ?? String(err));
        }
    }
);

/**
 * Get Phantom execution status (e.g. latest container, last run).
 * Maps to something like GET /agents/fetch?id=<agentId>
 */
server.registerTool(
    "phantom_status",
    {
        description:
            "Get status and metadata of a Phantombuster Phantom by its ID (last launch, state, etc).",
        inputSchema: z.object({
            agentId: z.string().describe("Phantom/agent ID from Phantombuster dashboard"),
        }),
    },
    async (input: any) => {
        try {
            const parsed = z.object({ agentId: z.string() }).parse(input);

            const data = await phRequest<any>("GET", "/agents/fetch", undefined, {
                id: parsed.agentId,
            });

            return {
                content: [
                    {
                        type: "text",
                        text: pretty({
                            action: "status",
                            agentId: parsed.agentId,
                            agent: data,
                        }),
                    },
                ],
            };
        } catch (err: any) {
            return errorContent(err?.message ?? String(err));
        }
    }
);

/**
 * Get Phantom latest results (output).
 * Many Phantoms expose their result URL in agent.lastResultObject, container, or dedicated API.
 * Here we assume there's an agent.lastResultObject or agent.lastContainer for results URL.
 */
server.registerTool(
    "phantom_results",
    {
        description:
            "Fetch the latest results for a Phantombuster Phantom by ID. Returns metadata and, if accessible, parsed JSON.",
        inputSchema: z.object({
            agentId: z.string().describe("Phantom/agent ID from Phantombuster dashboard"),
            raw: z.boolean().optional().default(false).describe(
                "If true, returns raw result URL and meta; if false, tries to fetch and parse JSON from result URL."
            ),
        }),
    },
    async (input: any) => {
        try {
            const parsed = z
                .object({
                    agentId: z.string(),
                    raw: z.boolean().optional().default(false),
                })
                .parse(input);

            // First, get agent info to locate result URL
            const agent = await phRequest<any>("GET", "/agents/fetch", undefined, {
                id: parsed.agentId,
            });

            const resultUrl =
                agent?.lastResultObject?.s3Folder ||
                agent?.lastResultObject?.s3Url ||
                agent?.lastContainer?.output?.url ||
                agent?.lastResultUrl ||
                null;

            if (!resultUrl) {
                return errorContent(
                    `No result URL found for Phantom agentId=${parsed.agentId}. Check if it has run successfully.`
                );
            }

            if (parsed.raw) {
                return {
                    content: [
                        {
                            type: "text",
                            text: pretty({
                                action: "results",
                                agentId: parsed.agentId,
                                resultUrl,
                                note: "raw mode - not fetching data, only URL/meta",
                            }),
                        },
                    ],
                };
            }

            // Try to fetch results from the URL (assuming JSON)
            let resultsData: any = null;
            try {
                const res = await axios.get(resultUrl, {
                    timeout: 60_000,
                });
                resultsData = res.data;
            } catch (err: any) {
                console.error("Error fetching results from result URL", err?.message || err);
            }

            return {
                content: [
                    {
                        type: "text",
                        text: pretty({
                            action: "results",
                            agentId: parsed.agentId,
                            resultUrl,
                            results: resultsData,
                        }),
                    },
                ],
            };
        } catch (err: any) {
            return errorContent(err?.message ?? String(err));
        }
    }
);

/**
 * List all Phantombuster agents/phantoms.
 * Helps find the correct agent ID for a specific Phantom.
 */
server.registerTool(
    "phantom_list",
    {
        description:
            "List all Phantombuster Phantoms/agents in your account. Returns a list of agents with their IDs, names, and scripts.",
        inputSchema: z.object({}),
    },
    async (input: any) => {
        try {
            // Phantombuster API endpoint to list all agents
            const data = await phRequest<any>("GET", "/agents/fetch-all");

            return {
                content: [
                    {
                        type: "text",
                        text: pretty({
                            action: "list",
                            agents: data,
                            count: Array.isArray(data) ? data.length : "unknown",
                        }),
                    },
                ],
            };
        } catch (err: any) {
            return errorContent(err?.message ?? String(err));
        }
    }
);

const app = express();
app.use(express.json());

app.all("/mcp", async (req, res) => {
    try {
        // 1) Extract Authorization header
        const authHeader = req.header("authorization") || "";

        let externalApiKey: string | undefined;

        if (authHeader.toLowerCase().startsWith("bearer ")) {
            externalApiKey = authHeader.slice("bearer ".length).trim();
        } else if (authHeader) {
            // If you want to support plain token without Bearer
            externalApiKey = authHeader.trim();
        }

        // Optional: enforce that a key must be provided
        if (!externalApiKey) {
            return res.status(401).json({
                jsonrpc: "2.0",
                error: { code: 401, message: "Missing Authorization API key" },
                id: null,
            });
        }

        const ctx = { externalApiKey };

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
            enableDnsRebindingProtection: false,
        });

        res.on("close", () => {
            transport.close().catch(() => { });
        });

        // 2) Run the whole MCP handling inside this request context
        await requestContext.run(ctx, async () => {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        });
    } catch (err) {
        console.error("Error handling /mcp request:", err);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null,
            });
        }
    }
});

const port = parseInt(process.env.PORT || "3000", 10);
app
    .listen(port, () => {
        console.log(`✅ Phantombuster MCP server running on http://localhost:${port}/mcp`);
    })
    .on("error", (error: Error) => {
        console.error("Server error:", error);
        process.exit(1);
    });