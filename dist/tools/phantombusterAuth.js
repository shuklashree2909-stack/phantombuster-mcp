"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPhantombusterApiKey = getPhantombusterApiKey;
exports.getPhantombusterBaseUrl = getPhantombusterBaseUrl;
require("dotenv/config");
function getPhantombusterApiKey() {
    const key = process.env.PHANTOMBUSTER_API_KEY;
    if (!key || !key.trim()) {
        console.error("\n❌ Missing PHANTOMBUSTER_API_KEY in environment.\n");
        throw new Error("PHANTOMBUSTER_API_KEY is required for the Phantombuster MCP server.");
    }
    return key.trim();
}
function getPhantombusterBaseUrl() {
    const base = process.env.PHANTOMBUSTER_API_BASE || "https://api.phantombuster.com/api/v2";
    return base.replace(/\/+$/, "");
}
