"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const zod_1 = require("zod");
const axios_1 = __importDefault(require("axios"));
const phantombusterAuth_1 = require("./tools/phantombusterAuth");
const context_1 = require("./context");
// -------------------
// Config & helpers
// -------------------
const PH_API_KEY = (0, phantombusterAuth_1.getPhantombusterApiKey)();
const PH_BASE_URL = (0, phantombusterAuth_1.getPhantombusterBaseUrl)();
const server = new mcp_js_1.McpServer({
    name: "phantombuster-mcp-server",
    version: "0.1.0",
}, {
    capabilities: {
        tools: {},
    },
});
function pretty(obj) {
    return JSON.stringify(obj, null, 2);
}
function errorContent(message) {
    return {
        content: [
            {
                type: "text",
                text: `Error: ${message}`,
            },
        ],
    };
}
// Generic request helper to Phantombuster
async function phRequest(method, path, body, params) {
    try {
        const ctx = context_1.requestContext.getStore();
        const apiKey = ctx?.externalApiKey;
        console.log("apiKey", apiKey);
        if (!apiKey) {
            throw new Error("No API key provided. Send 'Authorization: Bearer YOUR_PHANTOMBUSTER_KEY' in the MCP HTTP request.");
        }
        const url = `${PH_BASE_URL}${path}`;
        const res = await axios_1.default.request({
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
    }
    catch (err) {
        console.error("Phantombuster API error", err?.response?.data || err?.message || err);
        const msg = err?.response?.data?.error ||
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
server.registerTool("phantom_launch", {
    description: "Launch a Phantombuster Phantom by its ID with optional arguments (input). Returns launch information.",
    inputSchema: zod_1.z.object({
        agentId: zod_1.z.string().describe("Phantom/agent ID from Phantombuster dashboard"),
        argument: zod_1.z.record(zod_1.z.any()).optional().describe("Phantom input configuration (object passed as argument)"),
        manual: zod_1.z.boolean().optional().default(false).describe("If true, launches in manual mode (depends on Phantom settings)"),
    }),
}, async (input) => {
    try {
        const parsed = zod_1.z
            .object({
            agentId: zod_1.z.string(),
            argument: zod_1.z.record(zod_1.z.any()).optional(),
            manual: zod_1.z.boolean().optional().default(false),
        })
            .parse(input);
        // Endpoint is often something like /agents/launch
        // For some setups, it might be /agents/launch?id=<id>
        const data = await phRequest("POST", "/agents/launch", {
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
    }
    catch (err) {
        return errorContent(err?.message ?? String(err));
    }
});
/**
 * Get Phantom execution status (e.g. latest container, last run).
 * Maps to something like GET /agents/fetch?id=<agentId>
 */
server.registerTool("phantom_status", {
    description: "Get status and metadata of a Phantombuster Phantom by its ID (last launch, state, etc).",
    inputSchema: zod_1.z.object({
        agentId: zod_1.z.string().describe("Phantom/agent ID from Phantombuster dashboard"),
    }),
}, async (input) => {
    try {
        const parsed = zod_1.z.object({ agentId: zod_1.z.string() }).parse(input);
        const data = await phRequest("GET", "/agents/fetch", undefined, {
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
    }
    catch (err) {
        return errorContent(err?.message ?? String(err));
    }
});
/**
 * Get Phantom latest results (output).
 * Many Phantoms expose their result URL in agent.lastResultObject, container, or dedicated API.
 * Here we assume there's an agent.lastResultObject or agent.lastContainer for results URL.
 */
server.registerTool("phantom_results", {
    description: "Fetch the latest results for a Phantombuster Phantom by ID. Returns metadata and, if accessible, parsed JSON.",
    inputSchema: zod_1.z.object({
        agentId: zod_1.z.string().describe("Phantom/agent ID from Phantombuster dashboard"),
        raw: zod_1.z.boolean().optional().default(false).describe("If true, returns raw result URL and meta; if false, tries to fetch and parse JSON from result URL."),
    }),
}, async (input) => {
    try {
        const parsed = zod_1.z
            .object({
            agentId: zod_1.z.string(),
            raw: zod_1.z.boolean().optional().default(false),
        })
            .parse(input);
        // First, get agent info to locate result URL
        const agent = await phRequest("GET", "/agents/fetch", undefined, {
            id: parsed.agentId,
        });
        const resultUrl = agent?.lastResultObject?.s3Folder ||
            agent?.lastResultObject?.s3Url ||
            agent?.lastContainer?.output?.url ||
            agent?.lastResultUrl ||
            null;
        if (!resultUrl) {
            return errorContent(`No result URL found for Phantom agentId=${parsed.agentId}. Check if it has run successfully.`);
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
        let resultsData = null;
        try {
            const res = await axios_1.default.get(resultUrl, {
                timeout: 60_000,
            });
            resultsData = res.data;
        }
        catch (err) {
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
    }
    catch (err) {
        return errorContent(err?.message ?? String(err));
    }
});
/**
 * List all Phantombuster agents/phantoms.
 * Helps find the correct agent ID for a specific Phantom.
 */
server.registerTool("phantom_list", {
    description: "List all Phantombuster Phantoms/agents in your account. Returns a list of agents with their IDs, names, and scripts.",
    inputSchema: zod_1.z.object({}),
}, async (input) => {
    try {
        // Phantombuster API endpoint to list all agents
        const data = await phRequest("GET", "/agents/fetch-all");
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
    }
    catch (err) {
        return errorContent(err?.message ?? String(err));
    }
});
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.all("/mcp", async (req, res) => {
    try {
        // 1) Extract Authorization header
        const authHeader = req.header("authorization") || "";
        let externalApiKey;
        if (authHeader.toLowerCase().startsWith("bearer ")) {
            externalApiKey = authHeader.slice("bearer ".length).trim();
        }
        else if (authHeader) {
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
        const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
            enableDnsRebindingProtection: false,
        });
        res.on("close", () => {
            transport.close().catch(() => { });
        });
        // 2) Run the whole MCP handling inside this request context
        await context_1.requestContext.run(ctx, async () => {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        });
    }
    catch (err) {
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
    .on("error", (error) => {
    console.error("Server error:", error);
    process.exit(1);
});
