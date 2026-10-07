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
