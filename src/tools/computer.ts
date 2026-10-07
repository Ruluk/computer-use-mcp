import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {
	mouse,
	keyboard,
	Point,
	screen,
	Button,
	imageToJimp,
} from '@nut-tree-fork/nut-js';
import {execFileSync} from 'node:child_process';
import {readFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import Jimp from 'jimp';
import sharp from 'sharp';
import {toKeys} from '../utils/xdotoolStringToKeys.js';
import {jsonResult} from '../utils/response.js';
import {drawCrosshair, screenshotMetadata} from './screenshot.js';

/**
 * Grab the screen, falling back to the macOS `screencapture` CLI if nut-js fails
 * (e.g. on macOS 26+ where CGDisplayCreateImageForRect was removed).
 */
async function grabScreen(): Promise<{
	height: number;
	image: ReturnType<typeof imageToJimp>;
	scaleX?: number;
	scaleY?: number;
	width: number;
}> {
	try {
		const captured = await screen.grab();
		return {
			height: captured.height,
			image: imageToJimp(captured),
			scaleX: captured.pixelDensity.scaleX,
			scaleY: captured.pixelDensity.scaleY,
			width: captured.width,
		};
	} catch {
		// Fallback: use screencapture CLI (macOS only). Density is unknown until that path reports it.
		const tmpPath = join(tmpdir(), `computer-use-mcp-${Date.now()}.png`);
		try {
			execFileSync('screencapture', ['-x', tmpPath]);
			const buffer = readFileSync(tmpPath);
			const image = (await Jimp.read(buffer)) as unknown as ReturnType<typeof imageToJimp>;
			return {height: image.getHeight(), image, width: image.getWidth()};
		} finally {
			try {
				unlinkSync(tmpPath);
			} catch {
				/* ignore cleanup errors */
			}
		}
	}
}

// Configure nut-js
mouse.config.autoDelayMs = 100;
mouse.config.mouseSpeed = 1000;
keyboard.config.autoDelayMs = 10;

/**
 * Check if xdotool is available on this system.
 * Cached after first check.
 */
let xdotoolAvailable: boolean | undefined;
function hasXdotool(): boolean {
	if (xdotoolAvailable === undefined) {
		try {
			execFileSync('which', ['xdotool'], {stdio: 'ignore'});
			xdotoolAvailable = true;
		} catch {
			xdotoolAvailable = false;
		}
	}

	return xdotoolAvailable;
}

/**
 * Type text using xdotool, which correctly respects the X11 keyboard layout.
 *
 * nut-js's keyboard.type() uses libnut's typeString which maps characters to
 * X keycodes using a hardcoded US QWERTY lookup. This breaks when the X server's
 * keyboard layout differs, causing characters like : and ; to be swapped.
 * xdotool type uses XSendEvent with proper keymap lookups, so it works regardless
 * of the active keyboard layout.
 */
function xdotoolType(text: string): void {
	execFileSync('xdotool', [
		'type',
		'--clearmodifiers',
		'--delay',
		String(keyboard.config.autoDelayMs),
		'--',
		text,
	], {
		env: {...process.env, DISPLAY: process.env.DISPLAY || ':1'},
	});
}

// The Claude API automatically downsamples images larger than ~1.15MP or 1568px on the long edge.
// We already downsampled screenshots to fit these limits and reported the original screen
// dimensions via display_width_px/display_height_px, but Claude wasn't correctly using those
// reported dimensions - it was using coordinates from the downsampled image space directly.
// As a workaround, we now report the actual image dimensions and scale Claude's coordinates
// back up to logical screen coordinates.
// See: https://docs.anthropic.com/en/docs/build-with-claude/vision#evaluate-image-size
const maxLongEdge = 1568;
const maxPixels = 1.15 * 1024 * 1024; // 1.15 megapixels

/**
 * Calculate the scale factor to downsample an image to fit API limits.
 * Returns a value <= 1 representing how much to shrink the image.
 */
function getSizeToApiScale(width: number, height: number): number {
	const longEdge = Math.max(width, height);
	const totalPixels = width * height;

	const longEdgeScale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
	const pixelScale = totalPixels > maxPixels ? Math.sqrt(maxPixels / totalPixels) : 1;

	return Math.min(longEdgeScale, pixelScale);
}

/**
 * Get the scale factor from API image coordinates to logical screen coordinates.
 * This is the inverse of the downsampling we apply to fit API limits.
 */
async function getApiToLogicalScale(): Promise<number> {
	const logicalWidth = await screen.width();
	const logicalHeight = await screen.height();
	const apiScaleFactor = getSizeToApiScale(logicalWidth, logicalHeight);
	return 1 / apiScaleFactor;
}

// Define the action enum values
const ActionEnum = z.enum([
	'key',
	'type',
	'mouse_move',
	'left_click',
	'left_click_drag',
	'right_click',
	'middle_click',
	'double_click',
	'scroll',
	'get_screenshot',
	'get_cursor_position',
	'wait',
	'sequence',
]);

const actionDescription = `The action to perform. The available actions are:
* key: Press a key or key-combination on the keyboard.
* type: Type a string of text on the keyboard.
* get_cursor_position: Get the current cursor position as {x, y} in coordinate_space: api (default, reduced screenshot grid) or desktop (desktop grid). This does not move the cursor.
* mouse_move: Move the cursor to a specified (x, y) pixel coordinate on the screen.
* left_click: Click the left mouse button. If coordinate is provided, moves to that position first.
* left_click_drag: Click and drag the cursor to a specified (x, y) pixel coordinate on the screen.
* right_click: Click the right mouse button. If coordinate is provided, moves to that position first.
* middle_click: Click the middle mouse button. If coordinate is provided, moves to that position first.
* double_click: Double-click the left mouse button. If coordinate is provided, moves to that position first.
* scroll: Scroll the screen in a specified direction. Requires coordinate (moves there first) and text parameter with direction: "up", "down", "left", or "right". Optionally append ":N" to scroll N pixels (default 300), e.g. "down:500". Multiple scroll actions can be combined in one call by separating them with commas, e.g. "up:100,down:100".
* get_screenshot: Take a screenshot of the screen. The text before the image gives its size, desktop rectangle, captured pixel size, and desktop_per_image_pixel. Convert image points to desktop points yourself. This can be used as a standalone action or in a sequence.
* wait: Pause for duration_ms milliseconds (a positive integer up to 60000).
* sequence: Perform actions in order in a single tool call. Use the "actions" field to provide the array. At most one click, drag, key, or type action is allowed per sequence, since intermediate screenshots cannot be verified before the call ends. A screenshot afterward is recommended, but optional. All screenshots in a sequence are returned; otherwise the result is the last action's result.
`;

const toolDescription = `Use a mouse and keyboard to interact with a computer, and take screenshots.
* This is an interface to a desktop GUI. You do not have access to a terminal or applications menu. You must click on desktop icons to start applications.
* Coordinate spaces: mouse actions with a coordinate and get_cursor_position accept coordinate_space: api (default, reduced screenshot grid) or desktop (desktop grid). Desktop units can differ from captured pixels on a high-DPI display.
* Screenshot geometry: each screenshot reports image size, desktop_region, capture size, and desktop_per_image_pixel. Convert with desktop_x = desktop_region.left + image_x * desktop_per_image_pixel.x, and the same for y. Round to a desktop point inside that rectangle and send coordinate_space: desktop. The x and y factors use the actual image size, so they can differ. The server does not remember the screenshot.
* Always prefer using keyboard shortcuts rather than clicking, where possible.
* Efficient Workflow: Use 'sequence' to combine actions such as clicking, waiting, and taking a screenshot in a single tool call. At most one click, drag, key, or type action is allowed in a sequence. A screenshot afterward is highly recommended; another such action requires a new tool call so you can inspect the result first.
* If you see boxes with two letters in them, typing these letters will click that element. Use this instead of other shortcuts or clicking, where possible.
* Some applications may take time to start or process actions, so you may need to wait and take successive screenshots to see the results of your actions. E.g. if you click on Firefox and a window doesn't open, try taking another screenshot.
* Whenever you intend to move the cursor to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.
* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your cursor position so that the tip of the cursor visually falls on the element that you want to click.
* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.

Window focus:
* On macOS, clicking on a window that is not focused (e.g. behind another application) may only bring that window to the front without triggering the actual click on the element. If your click doesn't seem to have had an effect, take a screenshot to verify and click again — the window should now be focused and the second click will register.

Using the crosshair:
* Screenshots show a red crosshair at the current cursor position by default. Set screenshot.include_crosshair to false on get_screenshot to omit the marker; options are local to each sequence step.
* After clicking, check where the crosshair appears vs your target. If it missed, adjust coordinates proportionally to the distance - start with large adjustments and refine. Avoid small incremental changes when the crosshair is far from the target (distances are often further than you expect).
* Consider display dimensions when estimating positions. E.g. if it's 90% to the bottom of the screen, the coordinates should reflect this.`;

const coordinateSchema = z
	.array(z.number())
	.length(2)
	.describe('(x, y): Position from the left/top edge in coordinate_space (default: api). Desktop points are rounded and checked against display bounds.');
const coordinateSpaceSchema = z.enum(['api', 'desktop'])
	.describe('Coordinate grid for mouse actions with coordinate and get_cursor_position: api (default) uses the reduced screenshot grid; desktop uses the desktop grid directly. Cursor queries return {x, y} in the requested grid. Convert screenshot points with that screenshot\'s geometry; the server does not map them from a previous screenshot.');
const durationSchema = z.number().int().positive().max(60_000);
const screenshotOptionsSchema = z.object({
	include_crosshair: z.boolean().optional().describe('Draw the cursor crosshair (default: true).'),
}).strict().describe('Options for get_screenshot only; set separately on each screenshot step in a sequence.');

export function registerComputer(server: McpServer): void {
	server.registerTool(
		'computer',
		{
			title: 'Computer Control',
			description: toolDescription,
			inputSchema: z.object({
				action: ActionEnum.describe(actionDescription),
				coordinate: coordinateSchema.optional(),
				coordinate_space: coordinateSpaceSchema.optional(),
				screenshot: screenshotOptionsSchema.optional(),
				text: z.string().optional().describe('Text to type or key command to execute'),
				duration_ms: durationSchema.optional().describe('Milliseconds to wait (1 to 60000); required for wait'),
				actions: z.array(z.object({
					action: ActionEnum,
					coordinate: coordinateSchema.optional(),
					coordinate_space: coordinateSpaceSchema.optional(),
					screenshot: screenshotOptionsSchema.optional(),
					text: z.string().optional(),
					duration_ms: durationSchema.optional(),
				})).optional().describe('Actions to perform in order; at most one click, drag, key, or type action per sequence.'),
			}).strict(),
			// Note: No outputSchema because this tool returns varying content types including images
			annotations: {
				readOnlyHint: false,
			},
		},
		async function performAction(args: any): Promise<any> {
			const {action, coordinate, coordinate_space, screenshot, text, duration_ms, actions} = args as {
				action: z.infer<typeof ActionEnum>;
				coordinate?: [number, number];
				coordinate_space?: z.infer<typeof coordinateSpaceSchema>;
				screenshot?: z.infer<typeof screenshotOptionsSchema>;
				text?: string;
				duration_ms?: number;
				actions?: {action: z.infer<typeof ActionEnum>; coordinate?: [number, number]; coordinate_space?: z.infer<typeof coordinateSpaceSchema>; screenshot?: z.infer<typeof screenshotOptionsSchema>; text?: string; duration_ms?: number}[];
			};

			// Log action for security auditing
			console.error(`[Computer Tool] Action: ${action}${coordinate ? ` at (${coordinate[0]}, ${coordinate[1]})` : ''}${text ? ` with text: "${text}"` : ''}`);
			if (action !== 'wait' && duration_ms !== undefined) {
				throw new Error('duration_ms is only allowed for wait');
			}

			validateCoordinateSpace(args);
			validateScreenshotOptions(args);

			// Preserve legacy API scaling unless desktop coordinates are explicit
			let scaledCoordinate = coordinate;
			if (coordinate) {
				const scale = coordinate_space === 'desktop' ? 1 : await getApiToLogicalScale();
				scaledCoordinate = [
					Math.round(coordinate[0] * scale),
					Math.round(coordinate[1] * scale),
				];

				// Validate coordinates are within display bounds
				const [x, y] = scaledCoordinate;
				const [width, height] = [await screen.width(), await screen.height()];
				if (x < 0 || x >= width || y < 0 || y >= height) {
					throw new Error(`Coordinates (${x}, ${y}) are outside display bounds of ${width}x${height}`);
				}
			}

			// Implement system actions using nut-js
			switch (action) {
				case 'sequence': {
					if (coordinate || text) {
						throw new Error('Coordinates and text are not allowed when action is "sequence". Use the "actions" field instead.');
					}

					if (!actions || actions.length === 0) {
						throw new Error('Actions array required for sequence');
					}

					const consequentialActions: z.infer<typeof ActionEnum>[] = [
						'left_click',
						'left_click_drag',
						'right_click',
						'middle_click',
						'double_click',
						'key',
						'type',
					];

					let consequentialCount = 0;
					for (const seqAction of actions) {
						validateCoordinateSpace(seqAction);
						validateScreenshotOptions(seqAction);
						if (seqAction.action === 'sequence') {
							throw new Error('Nested sequences are not allowed');
						}

						if (seqAction.action === 'wait' && (seqAction.duration_ms === undefined || seqAction.coordinate || seqAction.text)) {
							throw new Error('wait requires duration_ms and does not accept coordinate or text');
						}

						if (seqAction.action !== 'wait' && seqAction.duration_ms !== undefined) {
							throw new Error('duration_ms is only allowed for wait');
						}

						if (consequentialActions.includes(seqAction.action)) {
							consequentialCount += 1;
							if (consequentialCount > 1) {
								throw new Error('Only one click, drag, key, or type action is allowed per sequence');
							}
						}
					}

					let lastResult;
					const screenshots: CallToolResult['content'] = [];
					for (const a of actions) {
						// eslint-disable-next-line no-await-in-loop -- Actions must finish before the next one starts.
						lastResult = await performAction(a);
						if (a.action === 'get_screenshot') {
							screenshots.push(...lastResult.content);
						}
					}

					if (screenshots.length === 0) {
						return lastResult;
					}

					if (actions.at(-1)?.action !== 'get_screenshot') {
						screenshots.push(...lastResult.content);
					}

					return {...lastResult, content: screenshots};
				}

				case 'wait': {
					if (duration_ms === undefined || coordinate || text || actions) {
						throw new Error('wait requires duration_ms and does not accept coordinate, text, or actions');
					}

					await sleep(duration_ms);
					return jsonResult({ok: true});
				}

				case 'key': {
					if (!text) {
						throw new Error('Text required for key');
					}

					const keys = toKeys(text);
					await keyboard.pressKey(...keys);
					await keyboard.releaseKey(...keys);

					return jsonResult({ok: true});
				}

				case 'type': {
					if (!text) {
						throw new Error('Text required for type');
					}

					if (process.platform === 'linux' && hasXdotool()) {
						xdotoolType(text);
					} else {
						await keyboard.type(text);
					}

					return jsonResult({ok: true});
				}

				case 'get_cursor_position': {
					const pos = await mouse.getPosition();
					const scale = coordinate_space === 'desktop' ? 1 : await getApiToLogicalScale();
					// Default to API image space; desktop queries use the desktop grid
					return jsonResult({
						x: Math.round(pos.x / scale),
						y: Math.round(pos.y / scale),
					});
				}

				case 'mouse_move': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for mouse_move');
					}

					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					return jsonResult({ok: true});
				}

				case 'left_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.leftClick();
					return jsonResult({ok: true});
				}

				case 'left_click_drag': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for left_click_drag');
					}

					await mouse.pressButton(Button.LEFT);
					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					await mouse.releaseButton(Button.LEFT);
					return jsonResult({ok: true});
				}

				case 'right_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.rightClick();
					return jsonResult({ok: true});
				}

				case 'middle_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.click(Button.MIDDLE);
					return jsonResult({ok: true});
				}

				case 'double_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.doubleClick(Button.LEFT);
					return jsonResult({ok: true});
				}

				case 'scroll': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for scroll');
					}

					if (!text) {
						throw new Error('Text required for scroll (direction like "up", "down:5")');
					}

					// Parse direction and optional amount from text (e.g. "down" or "down:5")
					const scrollCommands = text.split(',');

					for (const cmd of scrollCommands) {
						const parts = cmd.trim().split(':');
						const direction = parts[0];
						const amountStr = parts[1];
						const amount = amountStr ? parseInt(amountStr, 10) : 300;

						if (!direction) {
							throw new Error('Scroll direction required');
						}

						if (amountStr !== undefined && (isNaN(amount) || amount <= 0)) {
							throw new Error(`Invalid scroll amount: ${amountStr}`);
						}

						// Move to position first
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));

						// Scroll in the specified direction
						switch (direction.toLowerCase()) {
							case 'up':
								await mouse.scrollUp(amount);
								break;
							case 'down':
								await mouse.scrollDown(amount);
								break;
							case 'left':
								await mouse.scrollLeft(amount);
								break;
							case 'right':
								await mouse.scrollRight(amount);
								break;
							default:
								throw new Error(`Invalid scroll direction: ${direction}. Use "up", "down", "left", or "right"`);
						}
					}

					return jsonResult({ok: true});
				}

				case 'get_screenshot': {
					// Get cursor position in logical coordinates
					const cursorPos = await mouse.getPosition();

					// Capture the entire screen (may be at Retina resolution)
					const captured = await grabScreen();
					const {image} = captured;
					const desktopWidth = await screen.width();
					const desktopHeight = await screen.height();

					// Then resize to fit within API limits
					const apiScaleFactor = getSizeToApiScale(image.getWidth(), image.getHeight());
					if (apiScaleFactor < 1) {
						image.resize(
							Math.floor(image.getWidth() * apiScaleFactor),
							Math.floor(image.getHeight() * apiScaleFactor),
						);
					}

					const imageWidth = image.getWidth();
					const imageHeight = image.getHeight();
					const includeCrosshair = screenshot?.include_crosshair ?? true;
					if (includeCrosshair) {
						// Calculate cursor position in API image coordinates
						// cursor is in logical coords, need to convert to API image coords
						const scale = await getApiToLogicalScale();
						const cursorInImageX = Math.floor(cursorPos.x / scale);
						const cursorInImageY = Math.floor(cursorPos.y / scale);

						drawCrosshair(image, cursorInImageX, cursorInImageY);
					}

					// Get PNG buffer from Jimp
					const pngBuffer = await image.getBufferAsync('image/png');

					// Compress PNG using sharp, to fit size limits
					const optimizedBuffer = await sharp(pngBuffer)
						.png({quality: 80, compressionLevel: 9})
						.toBuffer();

					// Convert optimized buffer to base64
					const base64Data = optimizedBuffer.toString('base64');

					return {
						content: [
							{
								type: 'text',
								text: JSON.stringify(screenshotMetadata({
									captureHeight: captured.height,
									captureWidth: captured.width,
									desktopHeight,
									desktopWidth,
									imageHeight,
									imageWidth,
									includeCrosshair,
									scaleX: captured.scaleX,
									scaleY: captured.scaleY,
								})),
							},
							{
								type: 'image',
								data: base64Data,
								mimeType: 'image/png',
							},
						],
					};
				}
			}
		},
	);
}

function validateCoordinateSpace(args: {action: string; coordinate?: number[]; coordinate_space?: string}): void {
	const mouseActions = ['double_click', 'left_click', 'left_click_drag', 'middle_click', 'mouse_move', 'right_click', 'scroll'];
	const isCursorQuery = args.action === 'get_cursor_position' && !args.coordinate;
	if (args.coordinate_space !== undefined && !isCursorQuery && (!args.coordinate || !mouseActions.includes(args.action))) {
		throw new Error('coordinate_space is only allowed for mouse actions with coordinate or get_cursor_position without coordinate');
	}
}

function validateScreenshotOptions(args: {action: string; screenshot?: unknown}): void {
	if (args.screenshot !== undefined && args.action !== 'get_screenshot') {
		throw new Error('screenshot options are only allowed for get_screenshot');
	}
}
