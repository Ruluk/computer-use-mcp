import type {imageToJimp} from '@nut-tree-fork/nut-js';
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

export function resizeScreenshot(image: ReturnType<typeof imageToJimp>, resolution: ScreenshotResolution, apiScaleFactor: number): void {
	if (resolution === 'api' && apiScaleFactor < 1) {
		image.resize(
			Math.floor(image.getWidth() * apiScaleFactor),
			Math.floor(image.getHeight() * apiScaleFactor),
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

export type ScreenshotResolution = 'api' | 'native';

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
