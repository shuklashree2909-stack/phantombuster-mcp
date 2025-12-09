import "dotenv/config";

export function getPhantombusterApiKey(): string {
  const key = process.env.PHANTOMBUSTER_API_KEY;

  if (!key || !key.trim()) {
    console.error("\n❌ Missing PHANTOMBUSTER_API_KEY in environment.\n");
    throw new Error("PHANTOMBUSTER_API_KEY is required for the Phantombuster MCP server.");
  }

  return key.trim();
}

export function getPhantombusterBaseUrl(): string {
  const base = process.env.PHANTOMBUSTER_API_BASE || "https://api.phantombuster.com/api/v2";
  return base.replace(/\/+$/, "");
}

