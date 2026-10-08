# computer-use-mcp

💻 A Model Context Protocol server for Claude to control your computer. This is very similar to [computer use](https://docs.anthropic.com/en/docs/build-with-claude/computer-use), but easy to set up and use locally.

Here's Claude Haiku 4.5 changing my desktop background (4x speed):

https://github.com/user-attachments/assets/cd0bc190-52c4-49db-b3bc-4b8a74544789

> [!WARNING]
> At time of writing, models make frequent mistakes and are vulnerable to prompt injections. As this MCP server gives the model complete control of your computer, this could do a lot of damage. You should therefore treat this like giving a hyperactive toddler access to your computer - you probably want to supervise it closely, and consider only doing this in a sandboxed user account.

## Installation

Follow the instructions on [install-mcp](https://adamjones.me/install-mcp/?config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvbXB1dGVyLXVzZS1tY3AiXSwibmFtZSI6ImNvbXB1dGVyLXVzZSJ9), which generates the right config for your MCP client (Claude Code, Claude Desktop, Cursor, Cline, VS Code, and more).

## Tips

This should just work out of the box.

However, to get best results:
- Use a model good at computer use - I recommend [the latest Claude models](https://platform.claude.com/docs/en/about-claude/models/overview).
- Use a small, common resolution - 720p works particularly well. On macOS, you can use [displayoverride-mac](https://github.com/domdomegg/displayoverride-mac) to do this. If you can't use a different resolution, try zooming in to active windows.
- Install and enable the [Rango browser extension](https://chromewebstore.google.com/detail/rango/lnemjdnjjofijemhdogofbpcedhgcpmb). This enables keyboard navigation for websites, which is far more reliable than Claude trying to click coordinates. You can bump up the font size setting in Rango to make the hints more visible.

## How it works

We implement a near identical computer use tool to [Anthropic's official computer use guide](https://docs.anthropic.com/en/docs/build-with-claude/computer-use), with some more nudging to prefer keyboard shortcuts.

This talks to your computer using [nut.js](https://github.com/nut-tree/nut.js)

To click, wait for the interface to update, and see the result in one request, call the `computer` tool with:

```json
{"action":"sequence","actions":[{"action":"left_click","coordinate":[400,300]},{"action":"wait","duration_ms":1000},{"action":"get_screenshot"}]}
```

`wait` accepts 1–60000 milliseconds. A sequence can contain at most one click, drag, key, or type action, even if it includes screenshots: the caller cannot verify an intermediate screenshot until the request finishes. A final screenshot is optional but recommended. Multiple screenshots in one sequence are returned together.

### Screenshot annotations

Screenshots include a red cursor crosshair by default. To inspect content without the marker:

```json
{"action":"get_screenshot","screenshot":{"include_crosshair":false}}
```

The same options work on individual `get_screenshot` sequence steps, independently:

```json
{"action":"sequence","actions":[{"action":"get_screenshot","screenshot":{"include_crosshair":false}},{"action":"get_screenshot"}]}
```

Each image is preceded by its own metadata, including `include_crosshair`. Screenshot options are rejected on other actions or on the sequence itself before any sequence actions run. Disabling the crosshair removes only the tool's marker, not cursor pixels present in the capture. Resizing and compression remain unchanged.

### Screenshot resolution

`screenshot.resolution` accepts `api` (default), `native`, or `desktop`. API mode keeps the existing size limits and PNG compression. Native mode skips resizing and uses non-palette PNG; with the crosshair disabled, captured RGBA pixel values are preserved:

```json
{"action":"get_screenshot","screenshot":{"resolution":"native","include_crosshair":false}}
```

Native screenshots still include the crosshair unless disabled. On high-DPI displays their dimensions can exceed desktop dimensions. Each `get_screenshot` sequence step can choose its own resolution; use each image's metadata for coordinate conversion and send the converted point with `coordinate_space: "desktop"`.

Desktop mode resizes to the desktop's width and height and also uses non-palette PNG:

```json
{"action":"get_screenshot","screenshot":{"resolution":"desktop"}}
```

For full-screen desktop mode, image coordinates already match desktop coordinates; native mode instead retains all captured detail and may require density conversion. Crosshair placement uses the actual returned dimensions in every mode, including API mode's integer-rounded resizing. Legacy mouse-coordinate scaling is unchanged; use per-image geometry and explicit desktop coordinates for reliable conversion.

Downstream clients or providers may resize native images. The server reports dimensions of the PNG it returns, not a client's subsequently resized view; do not assume those grids match.

### Capture fallback and platform limits

If the SDK capture fails on macOS, the server uses non-interactive `screencapture -m` to capture only the main display, with a unique tool-owned temporary PNG removed after success or failure. SDK failures on other platforms are returned unchanged; the macOS command is not invoked there.

Fallback geometry is derived from the raw PNG and desktop dimensions. Empty/non-finite bounds or incompatible display/capture aspect ratios fail explicitly rather than returning guessed mappings. Native, desktop, and API modes share the same subsequent processing. Changing display geometry during a request can still cause a runtime failure.

Automated checks use mocked SDK/platform/artifact operations and real PNG processing. Live Windows 1× Firefox checkpoints also verified native crop-to-desktop-click conversion and foreground-window capture through MCP, with unchanged window focus and bounds. Live macOS permissions, high-DPI, and multi-display behavior remain unverified.

### Rectangle screenshots

`screenshot.region` selects a main-display rectangle in integer desktop coordinates before resizing. Width and height must be positive, and the rectangle must fit the display. Invalid rectangles are rejected before any sequence actions run; bounds are rechecked when capture executes. Later display changes can cause runtime failures that cannot undo earlier sequence actions.

```json
{"action":"get_screenshot","screenshot":{"region":{"left":100,"top":70,"width":80,"height":60},"resolution":"native","include_crosshair":false}}
```

This uses SDK region capture without moving the cursor. Each image reports its selected `desktop_region`, observed capture dimensions, and actual per-axis factors. Add the rectangle origin when converting image points: a 2× native crop point `(40,20)` in this example maps to desktop point `(120,80)`. Round and constrain the result, then send `coordinate_space: "desktop"`.

On macOS SDK failure, rectangle capture crops verified raw main-display fallback pixels before resolution processing. Fractional-density boundaries are rounded to raw pixel edges; metadata uses the requested desktop rectangle and actual integer crop/output dimensions. Unreliable or empty raw selections fail rather than substitute a full-screen image. Owned fallback artifacts are already removed before crop processing.

Crosshairs are positioned relative to the selected rectangle using actual output dimensions, and omitted entirely when the cursor is outside it. `include_crosshair` reports the requested annotation setting even when an outside cursor leaves no visible marker. Set it to `false` for unannotated pixels.

### Foreground-window screenshots

`screenshot.target` accepts `screen` (default) or `active_window`. Foreground-window targeting resolves current bounds when capture executes and reuses rectangle capture; it never focuses, moves, or resizes the window:

```json
{"action":"get_screenshot","screenshot":{"target":"active_window","resolution":"native","include_crosshair":false}}
```

The installed SDK clips window bounds to the main display, and the capture pipeline revalidates them. This captures visible screen content in that rectangle, not hidden or occluded window pixels. Unavailable or empty targets fail without full-screen substitution. An explicit `region` cannot be combined with `active_window`; conflicts are rejected before sequence side effects. Options remain local to each screenshot step, and metadata reports the selected `target` and effective rectangle.

### Coordinates

By default, positions use `coordinate_space: "api"`: a reduced coordinate grid based on the screenshot size limits. You can omit the field to keep that behavior.

To send a desktop point directly, use `"desktop"`:

```json
{"action":"left_click","coordinate":[850,460],"coordinate_space":"desktop"}
```

Desktop points are rounded to whole numbers and must fit inside the display. They are not always the same as captured pixels on a high-DPI screen.

Clients must convert positions found in screenshots into desktop points themselves. The server does not do that conversion or remember the previous screenshot.

Each screenshot's text, before the image, includes the numbers for that conversion:

```text
desktop_x = desktop_region.left + image_x * desktop_per_image_pixel.x
desktop_y = desktop_region.top + image_y * desktop_per_image_pixel.y
```

`desktop_per_image_pixel` uses the actual returned image size. The x and y factors can differ because resizing rounds each side separately. Round the result to a whole desktop point and keep it inside `desktop_region`. A default screenshot covers the whole desktop, so that rectangle starts at 0, 0. `capture_width` and `capture_height` are the pixels captured before resizing; on a high-DPI display they can be larger than the desktop size.

To get the cursor position in that same grid:

```json
{"action":"get_cursor_position","coordinate_space":"desktop"}
```

Cursor queries return `{x, y}` without moving the mouse. Both coordinate spaces work on individual sequence steps. Only use `coordinate_space` on mouse actions with a `coordinate` or on cursor queries—not on the sequence itself.

## Contributing

Pull requests are welcomed on GitHub! To get started:

1. Install Git and Node.js
2. Clone the repository
3. Install dependencies with `npm install`
4. Run `npm run test` to run tests
5. Build with `npm run build`

## Releases

Versions follow the [semantic versioning spec](https://semver.org/).

To release:

1. Use `npm version <major | minor | patch>` to bump the version
2. Run `git push --follow-tags` to push with tags
3. Wait for GitHub Actions to publish to the NPM registry.
