import {describe, it, expect} from 'vitest';
import type {JSONRPCMessage, JSONRPCRequest, JSONRPCResponse, ListToolsResult} from '@modelcontextprotocol/sdk/types.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../index.js';

describe('computer tool inputSchema', () => {
  it('advertises coordinate.items as an object schema (array elements), not an array (tuple items)', async () => {
    const server = createServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const sendRequest = async <T>(message: JSONRPCRequest): Promise<T> => {
      return new Promise((resolve, reject) => {
        clientTransport.onmessage = (response: JSONRPCMessage) => {
          const typedResponse = response as JSONRPCResponse;
          if ('result' in typedResponse) {
            resolve(typedResponse.result as T);
            return;
          }
          reject(new Error('No result in response'));
        };
        clientTransport.onerror = (err: Error) => reject(err);
        clientTransport.send(message).catch((err: unknown) => reject(err as Error));
      });
    };

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

    await server.close();
  });
});
