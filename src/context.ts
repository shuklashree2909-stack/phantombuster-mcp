import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  // this is the external API key passed from client via Authorization header
  externalApiKey?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
