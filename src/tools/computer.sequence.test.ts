import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {CallToolResult, JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import type * as nutJs from '@nut-tree-fork/nut-js';
import {
	describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {createServer} from '../index.js';

const events = vi.hoisted(() => [] as {action: string; at: number}[]);

vi.mock('@nut-tree-fork/nut-js', async (importOriginal) => ({
	...await importOriginal<typeof nutJs>(),
	mouse: {
		config: {},
		leftClick: vi.fn(async () => {
			events.push({action: 'click', at: Date.now()});
		}),
		setPosition: vi.fn(async () => {
			events.push({action: 'move', at: Date.now()});
		}),
		getPosition: vi.fn(async () => ({x: 0, y: 0})),
	},
	keyboard: {
		config: {},
		type: vi.fn(async () => {
			events.push({action: 'type', at: Date.now()});
		}),
	},
	screen: {
		width: vi.fn(async () => 1000),
		height: vi.fn(async () => 1000),
		grab: vi.fn(async () => {
			events.push({action: 'screenshot', at: Date.now()});
			return {width: 1000, height: 1000, pixelDensity: {scaleX: 1, scaleY: 1}};
		}),
	},
	imageToJimp: vi.fn((capture: {width: number; height: number}) => {
		let {width, height} = capture;
		return {
			getWidth: () => width,
			getHeight: () => height,
			resize(imageWidth: number, imageHeight: number) {
				width = imageWidth;
				height = imageHeight;
			},
			setPixelColor: vi.fn(),
			getBufferAsync: vi.fn(async () => Buffer.from('image')),
		};
	}),
}));

vi.mock('sharp', () => ({
	default: () => ({png: () => ({toBuffer: async () => Buffer.from('image')})}),
}));

describe('computer sequences', () => {
	let server: McpServer;
	let clientTransport: InMemoryTransport;

	beforeEach(async () => {
		events.length = 0;
		server = createServer();
		const [serverTransport, client] = InMemoryTransport.createLinkedPair();
		clientTransport = client;
		await server.connect(serverTransport);
	});

	afterEach(async () => {
		await server.close();
	});

	async function callSequence(actions: {action: string; coordinate?: number[]; text?: string; duration_ms?: number; screenshot?: Record<string, unknown>}[]): Promise<CallToolResult> {
		return new Promise((resolve, reject) => {
			clientTransport.onmessage = (message: JSONRPCMessage) => {
				if ('result' in message) {
					resolve(message.result as CallToolResult);
					return;
				}

				reject(new Error('MCP call failed'));
			};

			clientTransport.onerror = reject;
			clientTransport.send({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'sequence', actions}},
			}).catch(reject);
		});
	}

	it('clicks, waits, then returns a screenshot in one MCP request', async () => {
		const result = await callSequence([
			{action: 'left_click', coordinate: [100, 200]},
			{action: 'wait', duration_ms: 20},
			{action: 'get_screenshot'},
		]);

		expect(result.isError).not.toBe(true);
		expect(result.content.some((item) => item.type === 'image')).toBe(true);
		expect(events.map((event) => event.action)).toEqual(['move', 'click', 'screenshot']);
		expect(events[2]!.at - events[1]!.at).toBeGreaterThanOrEqual(20);
	});

	it('allows one consequential action without a screenshot', async () => {
		const result = await callSequence([{action: 'type', text: 'hello'}]);

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({ok: true});
		expect(events.map((event) => event.action)).toEqual(['type']);
	});

	it('rejects a second consequential action even after a screenshot, before doing anything', async () => {
		const result = await callSequence([
			{action: 'left_click'},
			{action: 'get_screenshot'},
			{action: 'left_click'},
		]);

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({type: 'text', text: expect.stringContaining('Only one')});
		expect(events).toEqual([]);
	});

	it.each([
		{action: 'sequence'},
		{action: 'wait', duration_ms: 1, text: 'ignored'},
		{action: 'left_click', duration_ms: 1},
		{action: 'mouse_move', coordinate: [100, 200], screenshot: {include_crosshair: false}},
		{action: 'get_screenshot', screenshot: {include_crosshair: 'false'}},
		{action: 'get_screenshot', screenshot: {unsupported: true}},
		{action: 'get_screenshot', screenshot: {resolution: 'thumbnail'}},
	])('rejects invalid sequence step $action before clicking', async (step) => {
		const result = await callSequence([{action: 'left_click'}, step]);

		expect(result.isError).toBe(true);
		expect(events).toEqual([]);
	});

	it.each([undefined, 0, -1, 1.5, 60_001])('rejects invalid wait duration %s before clicking', async (duration_ms) => {
		const wait = duration_ms === undefined ? {action: 'wait'} : {action: 'wait', duration_ms};
		const result = await callSequence([{action: 'left_click'}, wait]);

		expect(result.isError).toBe(true);
		expect(events).toEqual([]);
	});

	it('keeps each step-local resolution and annotation setting paired with its image', async () => {
		const result = await callSequence([
			{action: 'get_screenshot', screenshot: {resolution: 'native', include_crosshair: false}},
			{action: 'get_screenshot', screenshot: {resolution: 'desktop'}},
			{action: 'get_screenshot'},
		]);

		expect(result.isError).not.toBe(true);
		expect(result.content.map((item) => item.type)).toEqual(['text', 'image', 'text', 'image', 'text', 'image']);
		const first = result.content[0];
		const second = result.content[2];
		const third = result.content[4];
		if (first?.type !== 'text' || second?.type !== 'text' || third?.type !== 'text') {
			throw new Error('expected screenshot metadata');
		}

		expect(JSON.parse(first.text)).toMatchObject({resolution: 'native', include_crosshair: false});
		expect(JSON.parse(second.text)).toMatchObject({resolution: 'desktop', include_crosshair: true});
		expect(JSON.parse(third.text)).toMatchObject({resolution: 'api', include_crosshair: true});
	});
});
