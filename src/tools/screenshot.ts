import {imageToJimp, screen} from '@nut-tree-fork/nut-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync, rmSync} from 'node:fs';
import {platform, tmpdir} from 'node:os';
import {join} from 'node:path';
import Jimp from 'jimp';
import sharp from 'sharp';

export function drawCrosshair(image: ReturnType<typeof imageToJimp>, x: number, y: number): void {
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

export async function encodeScreenshot(image: ReturnType<typeof imageToJimp>, resolution: ScreenshotResolution): Promise<Buffer> {
	const pngBuffer = await image.getBufferAsync('image/png');
	return sharp(pngBuffer)
		.png(resolution === 'api' ? {quality: 80, compressionLevel: 9} : {compressionLevel: 9, palette: false})
		.toBuffer();
}

export async function grabScreen(desktopWidth: number, desktopHeight: number): Promise<CapturedScreenshot> {
	try {
		const captured = await screen.grab();
		const {height, width, pixelDensity: {scaleX, scaleY}} = captured;
		return {
			height, image: imageToJimp(captured), scaleX, scaleY, width,
		};
	} catch (error) {
		if (platform() !== 'darwin') {
			throw error;
		}

		return grabMainDisplayFallback(desktopWidth, desktopHeight);
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

export function screenshotMetadata(input: ScreenshotSource) {
	assertScreenshotMapping(input);
	return {
		image_width: input.imageWidth,
		image_height: input.imageHeight,
		resolution: input.resolution,
		desktop_width: input.desktopWidth,
		desktop_height: input.desktopHeight,
		desktop_region: {
			left: 0,
			top: 0,
			width: input.desktopWidth,
			height: input.desktopHeight,
		},
		capture_width: input.captureWidth,
		capture_height: input.captureHeight,
		desktop_per_image_pixel: {
			x: input.desktopWidth / input.imageWidth,
			y: input.desktopHeight / input.imageHeight,
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

	const widthMatches = Math.round(input.desktopWidth * input.scaleX) === input.captureWidth;
	const heightMatches = Math.round(input.desktopHeight * input.scaleY) === input.captureHeight;
	if (!widthMatches || !heightMatches) {
		throw new Error(`Cannot map screenshot pixels to desktop coordinates: capture ${input.captureWidth}x${input.captureHeight}, desktop ${input.desktopWidth}x${input.desktopHeight}, density ${input.scaleX}x${input.scaleY}`);
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

export type CapturedScreenshot = {
	height: number;
	image: ReturnType<typeof imageToJimp>;
	scaleX: number;
	scaleY: number;
	width: number;
};

export type ScreenshotResolution = 'api' | 'native' | 'desktop';

type ScreenshotSource = {
	captureHeight: number;
	captureWidth: number;
	desktopHeight: number;
	desktopWidth: number;
	imageHeight: number;
	imageWidth: number;
	includeCrosshair: boolean;
	resolution: ScreenshotResolution;
	scaleX?: number | undefined;
	scaleY?: number | undefined;
};
