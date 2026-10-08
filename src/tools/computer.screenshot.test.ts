import {
	describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import type {CallToolResult, JSONRPCMessage, JSONRPCRequest} from '@modelcontextprotocol/sdk/types.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type * as nutJs from '@nut-tree-fork/nut-js';
import {
	ColorMode, getActiveWindow, Image, imageToJimp, mouse, Point, Region, screen,
} from '@nut-tree-fork/nut-js';
import sharp from 'sharp';
import {execFileSync} from 'node:child_process';
import type * as childProcess from 'node:child_process';
import {readFileSync, rmSync} from 'node:fs';
import type * as fileSystem from 'node:fs';
import {platform} from 'node:os';
import type * as operatingSystem from 'node:os';
import {createServer} from '../index.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

const windowProvider = vi.hoisted(() => ({
	getWindowRegion: vi.fn(),
	focusWindow: vi.fn(),
	moveWindow: vi.fn(),
	resizeWindow: vi.fn(),
}));

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
		getActiveWindow: vi.fn(async () => new actual.Window({
			getScreen: () => ({screenSize: async () => ({width: 850, height: 400})}),
			getWindow: () => windowProvider,
		} as unknown as ConstructorParameters<typeof actual.Window>[0], 42)),
		mouse: {
			config: {},
			getPosition: vi.fn(async () => ({x: 10, y: 20})),
			setPosition: vi.fn().mockResolvedValue(undefined),
		},
		screen: {
			width: vi.fn(async () => 850),
			height: vi.fn(async () => 400),
			grab: vi.fn(async () => capture),
			grabRegion: vi.fn(async (region: nutJs.Region) => new actual.Image(region.width * 2, region.height * 2, Buffer.alloc(region.width * region.height * 16, 255), 4, 'high-dpi-region', 32, region.width * 8, actual.ColorMode.RGB, {scaleX: 2, scaleY: 2})),
		},
	};
});

vi.mock('node:child_process', async (importOriginal) => ({
	...await importOriginal<typeof childProcess>(),
	execFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
	...await importOriginal<typeof fileSystem>(),
	readFileSync: vi.fn(),
	rmSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => ({
	...await importOriginal<typeof operatingSystem>(),
	platform: vi.fn(),
}));

describe('computer screenshots', () => {
	let server: McpServer;
	let clientTransport: InMemoryTransport;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.mocked(execFileSync).mockReset().mockReturnValue(Buffer.alloc(0));
		vi.mocked(readFileSync).mockReset();
		vi.mocked(platform).mockReturnValue('win32');
		vi.mocked(screen.width).mockResolvedValue(850);
		vi.mocked(screen.height).mockResolvedValue(400);
		windowProvider.getWindowRegion.mockReset().mockResolvedValue(new Region(100, 70, 80, 60));
		server = createServer();
		const [serverTransport, client] = InMemoryTransport.createLinkedPair();
		clientTransport = client;
		await server.connect(serverTransport);
	});

	afterEach(async () => {
		await server.close();
		vi.restoreAllMocks();
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
			target: 'screen',
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
		const cursorOffset = ((36 * 1568) + 18) * 4;
		expect([...defaultPixels.subarray(cursorOffset, cursorOffset + 4)]).toEqual([255, 0, 0, 255]);
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

	it('delivers desktop-sized screenshots from a high-DPI capture through MCP', async () => {
		const result = await callComputer({action: 'get_screenshot', screenshot: {resolution: 'desktop'}});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot metadata and image');
		}

		expect(JSON.parse(text.text)).toMatchObject({
			resolution: 'desktop', include_crosshair: true,
			capture_width: 1700, capture_height: 800,
			image_width: 850, image_height: 400,
			desktop_per_image_pixel: {x: 1, y: 1},
		});
		await expect(sharp(Buffer.from(image.data, 'base64')).metadata()).resolves.toMatchObject({width: 850, height: 400});
		const pixels = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer();
		const cursorOffset = ((20 * 850) + 10) * 4;
		expect([...pixels.subarray(cursorOffset, cursorOffset + 4)]).toEqual([255, 0, 0, 255]);
	});

	it('converts rounded API crop geometry into a desktop-coordinate action', async () => {
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {
				region: {
					left: 40, top: 40, width: 800, height: 351,
				},
			},
		});
		const text = result.content[0];
		if (text?.type !== 'text') {
			throw new Error('expected screenshot metadata');
		}

		const geometry = JSON.parse(text.text) as {
			desktop_region: {left: number; top: number};
			desktop_per_image_pixel: {x: number; y: number};
		};
		const coordinate = [
			Math.round(geometry.desktop_region.left + (800 * geometry.desktop_per_image_pixel.x)),
			Math.round(geometry.desktop_region.top + (300 * geometry.desktop_per_image_pixel.y)),
		];
		const movement = await callComputer({action: 'mouse_move', coordinate_space: 'desktop', coordinate});

		expect(movement.isError).not.toBe(true);
		expect(mouse.setPosition).toHaveBeenCalledWith(expect.objectContaining({x: 448, y: 193}));
	});

	it('preserves SDK capture failures on unsupported platforms through MCP', async () => {
		const sdkError = new Error('original SDK capture failure');
		vi.mocked(screen.grab).mockRejectedValueOnce(sdkError);
		const result = await callComputer({action: 'get_screenshot'});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([expect.objectContaining({
			type: 'text', text: expect.stringContaining(sdkError.message),
		})]);
		expect(execFileSync).not.toHaveBeenCalled();
		expect(readFileSync).not.toHaveBeenCalled();
		expect(rmSync).not.toHaveBeenCalled();
	});

	it('returns main-display fallback pixels and verified geometry on macOS', async () => {
		const capture = await mockMacCaptureFailure();
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
			desktop_per_image_pixel: {x: 0.5, y: 0.5},
		});
		expect(execFileSync).toHaveBeenCalledWith('screencapture', expect.arrayContaining(['-m', '-x']));
		const {data, info} = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer({resolveWithObject: true});
		expect(info).toMatchObject({width: 1700, height: 800});
		expect(data.equals(capture.data), 'fallback PNG altered raw capture pixels').toBe(true);
	});

	it('owns unique fallback artifacts even when captures share a timestamp', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
		await mockMacCaptureFailure(await screen.grab());
		const first = await callComputer({action: 'get_screenshot'});
		vi.mocked(screen.grab).mockRejectedValueOnce(new Error('SDK unavailable'));
		const second = await callComputer({action: 'get_screenshot', screenshot: {resolution: 'desktop'}});

		expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
		expect(second.isError, JSON.stringify(second.content)).not.toBe(true);
		const paths = vi.mocked(execFileSync).mock.calls.map(([, args]) => (args as string[]).at(-1));
		expect(paths).toEqual([expect.stringMatching(/computer-use-mcp-.*\.png$/), expect.stringMatching(/computer-use-mcp-.*\.png$/)]);
		expect(new Set(paths).size).toBe(2);
		expect(vi.mocked(rmSync).mock.calls.map(([path]) => path)).toEqual(paths);
	});

	it('cleans only its own artifact when the fallback command fails', async () => {
		await mockMacCaptureFailure();
		vi.mocked(execFileSync).mockImplementationOnce(() => {
			throw new Error('fallback command failed');
		});
		const result = await callComputer({action: 'get_screenshot'});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([expect.objectContaining({
			type: 'text', text: expect.stringContaining('fallback command failed'),
		})]);
		const [, args] = vi.mocked(execFileSync).mock.calls[0]!;
		expect(vi.mocked(rmSync).mock.calls.map(([path]) => path)).toEqual([(args as string[]).at(-1)]);
	});

	it.each([
		{width: 850, height: 500},
		{width: 0, height: 400},
	])('rejects unreliable fallback mapping for desktop $width × $height', async ({width, height}) => {
		await mockMacCaptureFailure();
		vi.mocked(screen.width).mockResolvedValueOnce(width);
		vi.mocked(screen.height).mockResolvedValueOnce(height);
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {resolution: 'native', include_crosshair: false},
		});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([expect.objectContaining({
			type: 'text', text: expect.stringMatching(/main-display.*geometry|map screenshot/i),
		})]);
		expect(result.content.some((item) => item.type === 'image')).toBe(false);
	});

	it('resizes SDK rectangle captures to their selected desktop dimensions', async () => {
		const result = await callComputer({
			action: 'get_screenshot',
			screenshot: {
				region: {
					left: 100, top: 70, width: 80, height: 60,
				},
				resolution: 'desktop', include_crosshair: false,
			},
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot metadata and image');
		}

		expect(JSON.parse(text.text)).toMatchObject({
			capture_width: 160, capture_height: 120,
			image_width: 80, image_height: 60,
			desktop_per_image_pixel: {x: 1, y: 1},
		});
		await expect(sharp(Buffer.from(image.data, 'base64')).metadata()).resolves.toMatchObject({width: 80, height: 60});
	});

	it('preserves selected SDK rectangle pixels and reports their desktop origin', async () => {
		const capture = colorfulCapture();
		vi.mocked(screen.grabRegion).mockImplementationOnce(async (region) => captureRegion(capture, region));
		const region = {
			left: 100, top: 70, width: 80, height: 60,
		};
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {region, resolution: 'native', include_crosshair: false},
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot metadata and image');
		}

		expect(JSON.parse(text.text)).toMatchObject({
			desktop_width: 850, desktop_height: 400, desktop_region: region,
			capture_width: 160, capture_height: 120,
			image_width: 160, image_height: 120,
			desktop_per_image_pixel: {x: 0.5, y: 0.5},
		});
		const {data, info} = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer({resolveWithObject: true});
		expect(info).toMatchObject({width: 160, height: 120});
		const originOffset = ((140 * 1700) + 200) * 4;
		expect(data.subarray(0, 4)).toEqual(capture.data.subarray(originOffset, originOffset + 4));
		expect(screen.grabRegion).toHaveBeenCalledWith(expect.objectContaining(region));
		expect(screen.grab).not.toHaveBeenCalled();
	});

	it.each([
		{
			left: 800, top: 350, width: 80, height: 60,
		},
		{
			left: 10, top: 10, width: 0, height: 60,
		},
	])('preflights invalid rectangle $left,$top,$width,$height before sequence movement', async (region) => {
		const result = await callComputer({
			action: 'sequence', actions: [
				{action: 'mouse_move', coordinate: [20, 30], coordinate_space: 'desktop'},
				{action: 'get_screenshot', screenshot: {region}},
			],
		});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([expect.objectContaining({
			type: 'text', text: expect.stringMatching(/display bounds|width/i),
		})]);
		expect(mouse.setPosition).not.toHaveBeenCalled();
		expect(screen.grabRegion).not.toHaveBeenCalled();
	});

	it('preserves selected macOS fallback rectangle pixels and their origin', async () => {
		const capture = await mockMacCaptureFailure(colorfulCapture(), 'grabRegion');
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {
				region: {
					left: 100, top: 70, width: 80, height: 60,
				},
				resolution: 'native', include_crosshair: false,
			},
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot metadata and image');
		}

		expect(JSON.parse(text.text)).toMatchObject({
			desktop_region: {
				left: 100, top: 70, width: 80, height: 60,
			},
			capture_width: 160, capture_height: 120,
			desktop_per_image_pixel: {x: 0.5, y: 0.5},
		});
		const {data, info} = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer({resolveWithObject: true});
		expect(info).toMatchObject({width: 160, height: 120});
		const originOffset = ((140 * 1700) + 200) * 4;
		expect(data.subarray(0, 4)).toEqual(capture.data.subarray(originOffset, originOffset + 4));
	});

	it('rounds fractional-density fallback selection before native processing', async () => {
		await mockMacCaptureFailure(colorfulCapture(10, 10, 2.5), 'grabRegion');
		vi.mocked(screen.width).mockResolvedValue(4);
		vi.mocked(screen.height).mockResolvedValue(4);
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {
				region: {
					left: 1, top: 1, width: 3, height: 3,
				},
				resolution: 'native', include_crosshair: false,
			},
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot metadata and image');
		}

		expect(JSON.parse(text.text)).toMatchObject({
			capture_width: 7, capture_height: 7,
			desktop_per_image_pixel: {x: 3 / 7, y: 3 / 7},
		});
		const {data, info} = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer({resolveWithObject: true});
		expect(info).toMatchObject({width: 7, height: 7});
		expect([...data.subarray(0, 4)]).toEqual([33, 3, 0, 161]);
		expect([...data.subarray(-4)]).toEqual([99, 9, 0, 227]);
	});

	it('rejects a desktop rectangle that has no raw fallback pixels', async () => {
		await mockMacCaptureFailure(colorfulCapture(1, 1, 0.25), 'grabRegion');
		vi.mocked(screen.width).mockResolvedValue(4);
		vi.mocked(screen.height).mockResolvedValue(4);
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {
				region: {
					left: 0, top: 0, width: 1, height: 1,
				},
			},
		});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([expect.objectContaining({
			type: 'text', text: expect.stringMatching(/raw fallback pixels/i),
		})]);
		expect(rmSync).toHaveBeenCalledTimes(1);
	});

	it('maps the cursor into crop-local native pixels through MCP', async () => {
		vi.mocked(mouse.getPosition).mockResolvedValueOnce(new Point(120, 90));
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {
				region: {
					left: 100, top: 70, width: 80, height: 60,
				},
				resolution: 'native',
			},
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const image = result.content[1];
		if (image?.type !== 'image') {
			throw new Error('expected screenshot image');
		}

		const pixels = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer();
		const cursorOffset = ((40 * 160) + 40) * 4;
		expect([...pixels.subarray(cursorOffset, cursorOffset + 4)]).toEqual([255, 0, 0, 255]);
	});

	it('omits the marker entirely for an outside cursor in fallback crops', async () => {
		await mockMacCaptureFailure(await screen.grab(), 'grabRegion');
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {
				region: {
					left: 100, top: 70, width: 80, height: 60,
				},
				resolution: 'native',
			},
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot metadata and image');
		}

		expect(JSON.parse(text.text)).toMatchObject({include_crosshair: true});
		const pixels = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer();
		expect(pixels.every((channel) => channel === 255)).toBe(true);
	});

	it('pairs mixed crop options and full-screen defaults with their decoded images', async () => {
		const native = {
			left: 100, top: 70, width: 80, height: 60,
		};
		const desktop = {
			left: 300, top: 200, width: 40, height: 30,
		};
		const result = await callComputer({
			action: 'sequence', actions: [
				{action: 'get_screenshot', screenshot: {region: native, resolution: 'native', include_crosshair: false}},
				{action: 'get_screenshot', screenshot: {region: desktop, resolution: 'desktop'}},
				{action: 'get_screenshot'},
			],
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		expect(result.content.map((item) => item.type)).toEqual(['text', 'image', 'text', 'image', 'text', 'image']);
		const metadata = result.content.filter((item) => item.type === 'text').map((item) => JSON.parse(item.text));
		expect(metadata).toMatchObject([
			{desktop_region: native, resolution: 'native', include_crosshair: false},
			{desktop_region: desktop, resolution: 'desktop', include_crosshair: true},
			{
				desktop_region: {
					left: 0, top: 0, width: 850, height: 400,
				},
				resolution: 'api', include_crosshair: true,
			},
		]);
		const images = result.content.filter((item) => item.type === 'image');
		const decoded = await Promise.all(images.map(async (image) => sharp(Buffer.from(image.data, 'base64')).metadata()));
		expect(decoded).toMatchObject([{width: 160, height: 120}, {width: 40, height: 30}, {width: 1568, height: 737}]);
	});

	it('revalidates crop bounds after display geometry changes between sequence actions', async () => {
		vi.mocked(mouse.setPosition).mockImplementationOnce(async () => {
			vi.mocked(screen.width).mockResolvedValue(90);
		});
		const result = await callComputer({
			action: 'sequence', actions: [
				{action: 'mouse_move', coordinate: [20, 30], coordinate_space: 'desktop'},
				{
					action: 'get_screenshot', screenshot: {
						region: {
							left: 100, top: 70, width: 80, height: 60,
						},
					},
				},
			],
		});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([expect.objectContaining({
			type: 'text', text: expect.stringMatching(/display bounds.*90x400/i),
		})]);
		expect(mouse.setPosition).toHaveBeenCalledTimes(1);
		expect(screen.grabRegion).not.toHaveBeenCalled();
	});

	it('captures the foreground-window target through MCP', async () => {
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {target: 'active_window', resolution: 'native', include_crosshair: false},
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot metadata and image');
		}

		expect(JSON.parse(text.text)).toMatchObject({
			target: 'active_window', desktop_region: {
				left: 100, top: 70, width: 80, height: 60,
			},
		});
		await expect(sharp(Buffer.from(image.data, 'base64')).metadata()).resolves.toMatchObject({width: 160, height: 120});
	});

	it('resolves the current foreground window at capture time without focus or movement', async () => {
		vi.mocked(mouse.setPosition).mockImplementationOnce(async () => {
			windowProvider.getWindowRegion.mockResolvedValue(new Region(200, 100, 60, 30));
		});
		const result = await callComputer({
			action: 'sequence', actions: [
				{action: 'mouse_move', coordinate: [20, 30], coordinate_space: 'desktop'},
				{action: 'get_screenshot', screenshot: {target: 'active_window', resolution: 'native', include_crosshair: false}},
			],
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		if (text?.type !== 'text') {
			throw new Error('expected screenshot metadata');
		}

		expect(JSON.parse(text.text)).toMatchObject({
			target: 'active_window', desktop_region: {
				left: 200, top: 100, width: 60, height: 30,
			},
		});
		expect(vi.mocked(getActiveWindow).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(mouse.setPosition).mock.invocationCallOrder[0]!);
		expect(windowProvider.focusWindow).not.toHaveBeenCalled();
		expect(windowProvider.moveWindow).not.toHaveBeenCalled();
		expect(windowProvider.resizeWindow).not.toHaveBeenCalled();
	});

	it('rejects explicit regions with active-window targets before sequence side effects', async () => {
		const result = await callComputer({
			action: 'sequence', actions: [
				{action: 'mouse_move', coordinate: [20, 30], coordinate_space: 'desktop'},
				{
					action: 'get_screenshot', screenshot: {
						target: 'active_window', region: {
							left: 100, top: 70, width: 80, height: 60,
						},
					},
				},
			],
		});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([expect.objectContaining({
			type: 'text', text: expect.stringMatching(/region.*active_window|active_window.*region/i),
		})]);
		expect(mouse.setPosition).not.toHaveBeenCalled();
		expect(getActiveWindow).not.toHaveBeenCalled();
	});

	it('captures the active window intersection with the main display through MCP', async () => {
		windowProvider.getWindowRegion.mockResolvedValue(new Region(-40, -10, 150, 100));
		const result = await callComputer({
			action: 'get_screenshot', screenshot: {target: 'active_window', resolution: 'native', include_crosshair: false},
		});

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		const text = result.content[0];
		const image = result.content[1];
		if (text?.type !== 'text' || image?.type !== 'image') {
			throw new Error('expected screenshot metadata and image');
		}

		expect(JSON.parse(text.text)).toMatchObject({
			desktop_region: {
				left: 0, top: 0, width: 110, height: 90,
			},
		});
		await expect(sharp(Buffer.from(image.data, 'base64')).metadata()).resolves.toMatchObject({width: 220, height: 180});
	});

	it.each(['unavailable', 'empty'] as const)('rejects %s active-window targets without full-screen substitution', async (state) => {
		if (state === 'unavailable') {
			vi.mocked(getActiveWindow).mockRejectedValueOnce(new Error('active window unavailable'));
		} else {
			windowProvider.getWindowRegion.mockResolvedValue(new Region(900, 450, 80, 60));
		}

		const result = await callComputer({action: 'get_screenshot', screenshot: {target: 'active_window'}});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([expect.objectContaining({
			type: 'text', text: expect.stringMatching(/active window unavailable|display bounds/i),
		})]);
		expect(screen.grab).not.toHaveBeenCalled();
		expect(screen.grabRegion).not.toHaveBeenCalled();
		expect(execFileSync).not.toHaveBeenCalled();
	});
});

function captureRegion(capture: Image, region: nutJs.Region): Image {
	const {scaleX, scaleY} = capture.pixelDensity;
	const image = imageToJimp(capture).crop(region.left * scaleX, region.top * scaleY, region.width * scaleX, region.height * scaleY);
	return new Image(image.getWidth(), image.getHeight(), image.bitmap.data, 4, 'region', 32, image.getWidth() * 4, ColorMode.RGB, capture.pixelDensity);
}

function colorfulCapture(width = 1700, height = 800, density = 2): Image {
	const pixels = Buffer.alloc(width * height * 4);
	for (let offset = 0; offset < pixels.length; offset += 4) {
		const pixel = offset / 4;
		pixels[offset] = pixel % 256;
		pixels[offset + 1] = Math.floor(pixel / width) % 256;
		pixels[offset + 2] = Math.floor(pixel / 256) % 256;
		pixels[offset + 3] = 128 + (pixel % 128);
	}

	return new Image(width, height, pixels, 4, 'high-dpi', 32, width * 4, ColorMode.RGB, {scaleX: density, scaleY: density});
}

async function mockMacCaptureFailure(capture = colorfulCapture(), captureMethod: 'grab' | 'grabRegion' = 'grab'): Promise<Image> {
	vi.mocked(platform).mockReturnValue('darwin');
	vi.mocked(screen[captureMethod]).mockRejectedValueOnce(new Error('SDK unavailable'));
	vi.mocked(readFileSync).mockReturnValue(await imageToJimp(capture).getBufferAsync('image/png'));
	return capture;
}
