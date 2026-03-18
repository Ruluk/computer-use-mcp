import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type {JSONRPCMessage, JSONRPCRequest, JSONRPCResponse, ListToolsResult} from '@modelcontextprotocol/sdk/types.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../index.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

describe('computer tool', () => {
  let server: McpServer;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    server = createServer();
    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
  });

  afterEach(async () => {
    await server.close();
  });

  describe('inputSchema', () => {
    const sendRequest = async <T>(message: JSONRPCRequest): Promise<T> => {
      return new Promise((resolve, reject) => {
        clientTransport.onmessage = (response: JSONRPCMessage) => {
          const typedResponse = response as JSONRPCResponse;
          if ('error' in typedResponse) {
            resolve(typedResponse as any);
            return;
          }
          if ('result' in typedResponse) {
            resolve(typedResponse.result as T);
            return;
          }
          reject(new Error('No result or error in response'));
        };
        clientTransport.onerror = (err: Error) => reject(err);
        clientTransport.send(message).catch((err: unknown) => reject(err as Error));
      });
    };
    it('advertises coordinate.items as an object schema (array elements), not an array (tuple items)', async () => {
      const result = await sendRequest<ListToolsResult>({
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
        params: {},
      });

      const computer = result.tools.find((t) => t.name === 'computer')!;
      expect(computer).toBeDefined();
      // coordinate is optional, so check schema shape safely
      const coordinate = (computer.inputSchema as any)?.properties?.coordinate;
      expect(coordinate).toBeDefined();
      // items should be a single schema object, not an array of schemas
      expect(Array.isArray(coordinate.items)).toBe(false);
      expect(typeof coordinate.items).toBe('object');
    });

    it('supports sequence action and actions array in schema', async () => {
      const result = await sendRequest<ListToolsResult>({
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/list',
        params: {},
      });

      const computer = result.tools.find((t) => t.name === 'computer')!;
      const properties = (computer.inputSchema as any)?.properties;
      
      expect(properties.action.enum).toContain('sequence');
      expect(properties.actions).toBeDefined();
      expect(properties.actions.type).toBe('array');
      expect(properties.actions.items.type).toBe('object');
      expect(properties.actions.items.properties.action.enum).toEqual(properties.action.enum);
    });

    it('fails if sequence is called with coordinate or text', async () => {
      const resultWithCoord = await sendRequest<any>({
        jsonrpc: '2.0',
        id: '3',
        method: 'tools/call',
        params: {
          name: 'computer',
          arguments: {
            action: 'sequence',
            coordinate: [100, 100],
            actions: [{action: 'mouse_move', coordinate: [200, 200]}]
          },
        },
      });

      expect(resultWithCoord.isError).toBe(true);
      expect(resultWithCoord.content[0].text).toContain('Coordinates and text are not allowed when action is "sequence"');

      const resultWithText = await sendRequest<any>({
        jsonrpc: '2.0',
        id: '4',
        method: 'tools/call',
        params: {
          name: 'computer',
          arguments: {
            action: 'sequence',
            text: 'some text',
            actions: [{action: 'mouse_move', coordinate: [200, 200]}]
          },
        },
      });

      expect(resultWithText.isError).toBe(true);
      expect(resultWithText.content[0].text).toContain('Coordinates and text are not allowed when action is "sequence"');
    });
  });
});
