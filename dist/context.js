"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestContext = void 0;
const node_async_hooks_1 = require("node:async_hooks");
exports.requestContext = new node_async_hooks_1.AsyncLocalStorage();
