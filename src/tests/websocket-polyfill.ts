// This file provides a WebSocket polyfill for Node.js environments
// It's used in tests to simulate the browser's WebSocket global

import { WebSocket as NodeWebSocket } from 'ws';

// Only add the polyfill if WebSocket is not already defined (Node.js environment)
if (typeof globalThis.WebSocket === 'undefined') {
  // @ts-ignore - Assign the ws WebSocket implementation to the global object
  globalThis.WebSocket = NodeWebSocket;
}