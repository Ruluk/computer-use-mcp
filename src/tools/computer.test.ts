import {
	describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import type {
	CallToolResult, JSONRPCMessage, JSONRPCRequest, ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {mouse} from '@nut-tree-fork/nut-js';
import type * as nutJs from '@nut-tree-fork/nut-js';
import {createServer} from '../index.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('@nut-tree-fork/nut-js', async (importOriginal) => ({
	...await importOriginal<typeof nutJs>(),
	mouse: {
		config: {},
		getPosition: vi.fn(async () => ({x: 1049, y: 787})),
		leftClick: vi.fn(),
		setPosition: vi.fn(),
	},
	screen: {
		width: vi.fn(async () => 3840),
		height: vi.fn(async () => 2160),
	},
}));

describe('computer tool', () => {
	let server: McpServer;
	let clientTransport: InMemoryTransport;

	beforeEach(async () => {
		vi.clearAllMocks();
		server = createServer();
		const [serverTransport, client] = InMemoryTransport.createLinkedPair();
		clientTransport = client;
		await server.connect(serverTransport);
	});

	afterEach(async () => {
		await server.close();
	});

	async function callComputer(args: Record<string, unknown>): Promise<CallToolResult> {
		return sendRequest<CallToolResult>({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {name: 'computer', arguments: args},
		});
	}

	async function sendRequest<T>(message: JSONRPCRequest): Promise<T> {
		return new Promise((resolve, reject) => {
			clientTransport.onmessage = (response: JSONRPCMessage) => {
				if ('result' in response) {
					resolve(response.result as T);
				} else {
					reject(new Error('MCP request failed'));
				}
			};

			clientTransport.onerror = reject;
			clientTransport.send(message).catch(reject);
		});
	}

	describe('mouse coordinates', () => {
		it('moves directly to rounded desktop coordinates', async () => {
			const result = await callComputer({
				action: 'mouse_move', coordinate: [400.4, 300.6], coordinate_space: 'desktop',
			});

			expect(result.isError).not.toBe(true);
			expect(mouse.setPosition).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({x: 400, y: 301}));
		});

		it('uses each sequence step’s coordinate space and retains legacy scaling', async () => {
			const result = await callComputer({
				action: 'sequence',
				actions: [
					{action: 'mouse_move', coordinate: [400, 300]},
					{action: 'mouse_move', coordinate: [400, 300], coordinate_space: 'api'},
					{action: 'mouse_move', coordinate: [1000.4, 700.6], coordinate_space: 'desktop'},
				],
			});

			expect(result.isError).not.toBe(true);
			expect(vi.mocked(mouse.setPosition).mock.calls.map(([point]) => ({x: point.x, y: point.y}))).toEqual([
				{x: 1049, y: 787}, {x: 1049, y: 787}, {x: 1000, y: 701},
			]);
		});

		it('rejects a desktop point that rounds outside the display before moving', async () => {
			const result = await callComputer({
				action: 'mouse_move', coordinate: [3839.6, 100], coordinate_space: 'desktop',
			});

			expect(result.isError).toBe(true);
			expect(result.content[0]).toMatchObject({type: 'text', text: expect.stringMatching(/outside display bounds/)});
			expect(mouse.setPosition).not.toHaveBeenCalled();
		});

		it.each([
			{action: 'wait', duration_ms: 1, coordinate_space: 'desktop'},
			{
				action: 'sequence',
				actions: [
					{action: 'left_click'},
					{action: 'wait', duration_ms: 1, coordinate_space: 'desktop'},
				],
			},
		])('rejects unsupported coordinate spaces in $action before side effects', async (args) => {
			const result = await callComputer(args);

			expect(result.isError).toBe(true);
			expect(result.content[0]).toMatchObject({type: 'text', text: expect.stringMatching(/coordinate_space is only allowed/)});
			expect(mouse.leftClick).not.toHaveBeenCalled();
			expect(mouse.setPosition).not.toHaveBeenCalled();
		});
	});

	describe('cursor coordinates', () => {
		it('reports the requested cursor grid standalone and in sequences while preserving the legacy response', async () => {
			const desktop = await callComputer({action: 'get_cursor_position', coordinate_space: 'desktop'});
			expect(desktop.isError).not.toBe(true);
			expect(desktop.structuredContent).toEqual({x: 1049, y: 787});

			const legacy = await callComputer({action: 'get_cursor_position'});
			expect(legacy.isError).not.toBe(true);
			expect(legacy.structuredContent).toEqual({x: 400, y: 300});

			const sequence = await callComputer({
				action: 'sequence',
				actions: [
					{action: 'get_cursor_position', coordinate_space: 'api'},
					{action: 'get_cursor_position', coordinate_space: 'desktop'},
				],
			});
			expect(sequence.isError).not.toBe(true);
			expect(sequence.structuredContent).toEqual({x: 1049, y: 787});
			expect(mouse.setPosition).not.toHaveBeenCalled();
		});
	});

	describe('inputSchema', () => {
		it.each([
			{
				action: 'mouse_move', coordinate: [100, 100], screenshot: {include_crosshair: false},
			},
			{
				action: 'sequence', screenshot: {include_crosshair: false},
				actions: [{action: 'mouse_move', coordinate: [100, 100]}],
			},
		])('rejects screenshot options on $action before moving', async (args) => {
			const result = await callComputer(args);

			expect(result.isError).toBe(true);
			expect(mouse.setPosition).not.toHaveBeenCalled();
		});

		it('advertises coordinate.items as an object schema (array elements), not an array (tuple items)', async () => {
			const result = await sendRequest<ListToolsResult>({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: {},
			});

			const computer = result.tools.find((tool) => tool.name === 'computer');
			expect(computer).toBeDefined();
			const coordinate = computer?.inputSchema.properties?.coordinate as {items?: unknown} | undefined;
			expect(coordinate).toBeDefined();
			expect(Array.isArray(coordinate?.items)).toBe(false);
			expect(typeof coordinate?.items).toBe('object');
		});

		it.each([{coordinate: [100, 100]}, {text: 'some text'}])('rejects top-level sequence arguments %j before moving', async (args) => {
			const result = await callComputer({
				action: 'sequence',
				...args,
				actions: [{action: 'mouse_move', coordinate: [200, 200]}],
			});

			expect(result.isError).toBe(true);
			expect(result.content[0]).toMatchObject({type: 'text', text: expect.stringMatching(/Coordinates and text are not allowed/)});
			expect(mouse.setPosition).not.toHaveBeenCalled();
		});
	});
});
