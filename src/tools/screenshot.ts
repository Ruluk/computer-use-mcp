import {
	getActiveWindow, imageToJimp, Point, Region, screen,
} from '@nut-tree-fork/nut-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync, rmSync} from 'node:fs';
import {platform, tmpdir} from 'node:os';
import {join} from 'node:path';
import Jimp from 'jimp';
import sharp from 'sharp';

export function annotateScreenshot(image: ReturnType<typeof imageToJimp>, cursor: {x: number; y: number}, region: DesktopRegion): void {
	const x = cursor.x - region.left;
	const y = cursor.y - region.top;
	if (x < 0 || y < 0 || x >= region.width || y >= region.height) {
		return;
	}

	drawCrosshair(image, Math.floor((x * image.getWidth()) / region.width), Math.floor((y * image.getHeight()) / region.height));
}

export function assertRegionBounds(region: DesktopRegion, desktopWidth: number, desktopHeight: number): void {
	const validIntegers = [region.left, region.top, region.width, region.height, desktopWidth, desktopHeight].every(Number.isSafeInteger);
	if (!validIntegers || region.width <= 0 || region.height <= 0 || region.left < 0 || region.top < 0
		|| region.left + region.width > desktopWidth || region.top + region.height > desktopHeight) {
		throw new Error(`Screenshot region is outside display bounds of ${desktopWidth}x${desktopHeight}`);
	}
}

export async function encodeScreenshot(image: ReturnType<typeof imageToJimp>, resolution: ScreenshotResolution): Promise<Buffer> {
	const pngBuffer = await image.getBufferAsync('image/png');
	return sharp(pngBuffer)
		.png(resolution === 'api' ? {quality: 80, compressionLevel: 9} : {compressionLevel: 9, palette: false})
		.toBuffer();
}

export async function grabScreen(desktopWidth: number, desktopHeight: number, region?: DesktopRegion): Promise<CapturedScreenshot> {
	if (region) {
		assertRegionBounds(region, desktopWidth, desktopHeight);
	}

	try {
		const captured = region
			? await screen.grabRegion(new Region(region.left, region.top, region.width, region.height))
			: await screen.grab();
		const {height, width, pixelDensity: {scaleX, scaleY}} = captured;
		return {
			height, image: imageToJimp(captured), scaleX, scaleY, width,
		};
	} catch (error) {
		if (platform() !== 'darwin') {
			throw error;
		}

		const captured = await grabMainDisplayFallback(desktopWidth, desktopHeight);
		return region ? cropFallbackCapture(captured, region) : captured;
	}
}

export function resizeScreenshot(image: ReturnType<typeof imageToJimp>, resolution: ScreenshotResolution, size: {apiScaleFactor: number; desktopWidth: number; desktopHeight: number}): void {
	if (resolution === 'desktop') {
		image.resize(size.desktopWidth, size.desktopHeight);
	} else if (resolution === 'api' && size.apiScaleFactor < 1) {
		image.resize(
			Math.floor(image.getWidth() * size.apiScaleFactor),
			Math.floor(image.getHeight() * size.apiScaleFactor),
		);
	}
}

export async function resolveScreenshotRegion(desktopWidth: number, desktopHeight: number, target: ScreenshotTarget, region?: DesktopRegion): Promise<DesktopRegion> {
	if (target === 'active_window') {
		const window = await getActiveWindow();
		const {left, top, width, height} = await window.getRegion();
		return {
			left, top, width, height,
		};
	}

	return region ?? {
		left: 0, top: 0, width: desktopWidth, height: desktopHeight,
	};
}

export async function samplePixelColor(x: number, y: number): Promise<PixelColor> {
	try {
		const {R, G, B, A} = await screen.colorAt(new Point(x, y));
		return {
			r: R, g: G, b: B, a: A,
		};
	} catch (error) {
		if (platform() !== 'darwin') {
			throw error;
		}

		return sampleFallbackPixel(x, y);
	}
}

export function screenshotMetadata(input: ScreenshotSource) {
	assertScreenshotMapping(input);
	return {
		image_width: input.imageWidth,
		image_height: input.imageHeight,
		resolution: input.resolution,
		target: input.target,
		desktop_width: input.desktopWidth,
		desktop_height: input.desktopHeight,
		desktop_region: input.desktopRegion,
		capture_width: input.captureWidth,
		capture_height: input.captureHeight,
		desktop_per_image_pixel: {
			x: input.desktopRegion.width / input.imageWidth,
			y: input.desktopRegion.height / input.imageHeight,
		},
		include_crosshair: input.includeCrosshair,
	};
}

function assertFallbackGeometry(width: number, height: number, desktopWidth: number, desktopHeight: number): {scaleX: number; scaleY: number} {
	const validBounds = [width, height, desktopWidth, desktopHeight].every((size) => Number.isSafeInteger(size) && size > 0);
	const scaleX = width / desktopWidth;
	const scaleY = height / desktopHeight;
	// Allow one captured pixel of rounding at fractional display densities.
	if (!validBounds || Math.abs(scaleX - scaleY) > Math.max(1 / desktopWidth, 1 / desktopHeight)) {
		throw new Error('Cannot establish reliable main-display capture geometry');
	}

	return {scaleX, scaleY};
}

function assertScreenshotMapping(input: ScreenshotSource): void {
	if (input.imageWidth < 1 || input.imageHeight < 1) {
		throw new Error('Cannot map screenshot pixels to desktop coordinates');
	}

	if (input.scaleX === undefined || input.scaleY === undefined) {
		return;
	}

	const fullScreen = input.desktopRegion.left === 0 && input.desktopRegion.top === 0
		&& input.desktopRegion.width === input.desktopWidth && input.desktopRegion.height === input.desktopHeight;
	const roundingTolerance = fullScreen ? 0 : 1;
	const widthMatches = Math.abs(Math.round(input.desktopRegion.width * input.scaleX) - input.captureWidth) <= roundingTolerance;
	const heightMatches = Math.abs(Math.round(input.desktopRegion.height * input.scaleY) - input.captureHeight) <= roundingTolerance;
	if (!widthMatches || !heightMatches) {
		throw new Error(`Cannot map screenshot pixels to desktop coordinates: capture ${input.captureWidth}x${input.captureHeight}, desktop ${input.desktopWidth}x${input.desktopHeight}, density ${input.scaleX}x${input.scaleY}`);
	}
}

function cropFallbackCapture(captured: CapturedScreenshot, region: DesktopRegion): CapturedScreenshot {
	const left = Math.round(region.left * captured.scaleX);
	const top = Math.round(region.top * captured.scaleY);
	const right = Math.round((region.left + region.width) * captured.scaleX);
	const bottom = Math.round((region.top + region.height) * captured.scaleY);
	const width = right - left;
	const height = bottom - top;
	if (width < 1 || height < 1 || right > captured.width || bottom > captured.height) {
		throw new Error('Cannot map screenshot rectangle to raw fallback pixels');
	}

	captured.image.crop(left, top, width, height);
	return {...captured, height, width};
}

function drawCrosshair(image: ReturnType<typeof imageToJimp>, x: number, y: number): void {
	const imageWidth = image.getWidth();
	const imageHeight = image.getHeight();
	const crosshairSize = 20;
	const crosshairColor = 0xFF0000FF;

	if (y >= 0 && y < imageHeight) {
		for (let lineX = Math.max(0, x - crosshairSize); lineX <= Math.min(imageWidth - 1, x + crosshairSize); lineX++) {
			for (let lineY = Math.max(0, y - 1); lineY <= Math.min(imageHeight - 1, y + 1); lineY++) {
				image.setPixelColor(crosshairColor, lineX, lineY);
			}
		}
	}

	if (x >= 0 && x < imageWidth) {
		for (let lineY = Math.max(0, y - crosshairSize); lineY <= Math.min(imageHeight - 1, y + crosshairSize); lineY++) {
			for (let lineX = Math.max(0, x - 1); lineX <= Math.min(imageWidth - 1, x + 1); lineX++) {
				image.setPixelColor(crosshairColor, lineX, lineY);
			}
		}
	}
}

async function grabMainDisplayFallback(desktopWidth: number, desktopHeight: number): Promise<CapturedScreenshot> {
	const tmpPath = join(tmpdir(), `computer-use-mcp-${randomUUID()}.png`);
	try {
		execFileSync('screencapture', ['-x', '-m', tmpPath]);
		const image = (await Jimp.read(readFileSync(tmpPath))) as unknown as ReturnType<typeof imageToJimp>;
		const height = image.getHeight();
		const width = image.getWidth();
		const {scaleX, scaleY} = assertFallbackGeometry(width, height, desktopWidth, desktopHeight);
		return {
			height, image, scaleX, scaleY, width,
		};
	} finally {
		rmSync(tmpPath, {force: true});
	}
}

async function sampleFallbackPixel(x: number, y: number): Promise<PixelColor> {
	const desktopWidth = await screen.width();
	const desktopHeight = await screen.height();
	if (x < 0 || y < 0 || x >= desktopWidth || y >= desktopHeight) {
		throw new Error('Pixel coordinate is outside main-display bounds');
	}

	const captured = await grabMainDisplayFallback(desktopWidth, desktopHeight);
	const pixelX = Math.min(captured.width - 1, Math.round(x * captured.scaleX));
	const pixelY = Math.min(captured.height - 1, Math.round(y * captured.scaleY));
	const offset = ((pixelY * captured.width) + pixelX) * 4;
	const pixels = captured.image.bitmap.data;
	return {
		r: pixels.readUInt8(offset), g: pixels.readUInt8(offset + 1),
		b: pixels.readUInt8(offset + 2), a: pixels.readUInt8(offset + 3),
	};
}

export type CapturedScreenshot = {
	height: number;
	image: ReturnType<typeof imageToJimp>;
	scaleX: number;
	scaleY: number;
	width: number;
};

export type DesktopRegion = {
	left: number;
	top: number;
	width: number;
	height: number;
};

export type PixelColor = {
	r: number;
	g: number;
	b: number;
	a: number;
};

export type ScreenshotResolution = 'api' | 'native' | 'desktop';

export type ScreenshotTarget = 'screen' | 'active_window';

type ScreenshotSource = {
	captureHeight: number;
	captureWidth: number;
	desktopHeight: number;
	desktopRegion: DesktopRegion;
	desktopWidth: number;
	imageHeight: number;
	imageWidth: number;
	includeCrosshair: boolean;
	resolution: ScreenshotResolution;
	scaleX?: number | undefined;
	scaleY?: number | undefined;
	target: ScreenshotTarget;
};
