export function screenshotMetadata(input: ScreenshotSource) {
	assertScreenshotMapping(input);
	return {
		image_width: input.imageWidth,
		image_height: input.imageHeight,
		resolution: 'api' as const,
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
		include_crosshair: true,
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

type ScreenshotSource = {
	captureHeight: number;
	captureWidth: number;
	desktopHeight: number;
	desktopWidth: number;
	imageHeight: number;
	imageWidth: number;
	scaleX?: number | undefined;
	scaleY?: number | undefined;
};
