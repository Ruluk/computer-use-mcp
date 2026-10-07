import {
	describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import type {CallToolResult, JSONRPCMessage, JSONRPCRequest} from '@modelcontextprotocol/sdk/types.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type * as nutJs from '@nut-tree-fork/nut-js';
import {ColorMode, Image, screen} from '@nut-tree-fork/nut-js';
import sharp from 'sharp';
import {createServer} from '../index.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('@nut-tree-fork/nut-js', async (importOriginal) => {
	const actual = await importOriginal<typeof nutJs>();
	const capture = new actual.Image(
		1700,
		800,
		Buffer.alloc(1700 * 800 * 4, 255),
		4,
		'high-dpi',
		32,
		1700 * 4,
		actual.ColorMode.RGB,
		{scaleX: 2, scaleY: 2},
	);
	return {
		...actual,
		mouse: {
			config: {},
			getPosition: vi.fn(async () => ({x: 10, y: 20})),
		},
		screen: {
			width: vi.fn(async () => 850),
			height: vi.fn(async () => 400),
			grab: vi.fn(async () => capture),
		},
	};
});

describe('computer screenshots', () => {
	let server: McpServer;
	let clientTransport: InMemoryTransport;

	beforeEach(async () => {
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

	it('reports observed desktop geometry after the default API resize', async () => {
		const result = await callComputer({action: 'get_screenshot'});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		expect(text).toMatchObject({type: 'text'});
		expect(image).toMatchObject({type: 'image', mimeType: 'image/png'});
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot text and image');
		}

		expect(JSON.parse(text.text)).toEqual({
			image_width: 1568,
			image_height: 737,
			resolution: 'api',
			desktop_width: 850,
			desktop_height: 400,
			desktop_region: {
				left: 0, top: 0, width: 850, height: 400,
			},
			capture_width: 1700,
			capture_height: 800,
			desktop_per_image_pixel: {x: 850 / 1568, y: 400 / 737},
			include_crosshair: true,
		});
		await expect(sharp(Buffer.from(image.data, 'base64')).metadata()).resolves.toMatchObject({width: 1568, height: 737});
	});

	it('draws the default crosshair but leaves disabled screenshots unannotated', async () => {
		const annotated = await callComputer({action: 'get_screenshot'});
		const unannotated = await callComputer({action: 'get_screenshot', screenshot: {include_crosshair: false}});

		expect(unannotated.isError, JSON.stringify(unannotated.content)).not.toBe(true);
		const cleanMetadata = unannotated.content[0];
		const defaultImage = annotated.content[1];
		const cleanImage = unannotated.content[1];
		if (cleanMetadata?.type !== 'text' || defaultImage?.type !== 'image' || cleanImage?.type !== 'image') {
			throw new Error('expected screenshot metadata and images');
		}

		expect(JSON.parse(cleanMetadata.text)).toMatchObject({include_crosshair: false});
		const defaultPixels = await sharp(Buffer.from(defaultImage.data, 'base64')).ensureAlpha().raw().toBuffer();
		const cleanPixels = await sharp(Buffer.from(cleanImage.data, 'base64')).ensureAlpha().raw().toBuffer();
		expect(defaultPixels.includes(Buffer.from([255, 0, 0, 255]))).toBe(true);
		expect(cleanPixels.every((channel) => channel === 255)).toBe(true);
	});

	it('places the default crosshair in native pixel coordinates', async () => {
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {resolution: 'native'},
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot metadata and image');
		}

		expect(JSON.parse(text.text)).toMatchObject({resolution: 'native', include_crosshair: true});
		const pixels = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer();
		const cursorOffset = ((40 * 1700) + 20) * 4;
		expect([...pixels.subarray(cursorOffset, cursorOffset + 4)]).toEqual([255, 0, 0, 255]);
	});

	it('preserves captured RGBA pixels and high-DPI geometry in unannotated native screenshots', async () => {
		const capture = colorfulCapture();
		vi.mocked(screen.grab).mockResolvedValueOnce(capture);
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {resolution: 'native', include_crosshair: false},
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot metadata and image');
		}

		expect(JSON.parse(text.text)).toMatchObject({
			resolution: 'native', include_crosshair: false,
			capture_width: 1700, capture_height: 800,
			image_width: 1700, image_height: 800,
			desktop_region: {
				left: 0, top: 0, width: 850, height: 400,
			},
			desktop_per_image_pixel: {x: 0.5, y: 0.5},
		});
		const {data, info} = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer({resolveWithObject: true});
		expect(info).toMatchObject({width: 1700, height: 800, channels: 4});
		expect(data.equals(capture.data), 'native PNG altered captured RGBA pixels').toBe(true);
	});
});

function colorfulCapture(): Image {
	const pixels = Buffer.alloc(1700 * 800 * 4);
	for (let offset = 0; offset < pixels.length; offset += 4) {
		const pixel = offset / 4;
		pixels[offset] = pixel % 256;
		pixels[offset + 1] = Math.floor(pixel / 1700) % 256;
		pixels[offset + 2] = Math.floor(pixel / 256) % 256;
		pixels[offset + 3] = 128 + (pixel % 128);
	}

	return new Image(1700, 800, pixels, 4, 'high-dpi', 32, 1700 * 4, ColorMode.RGB, {scaleX: 2, scaleY: 2});
}
