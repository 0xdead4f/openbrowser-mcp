// The tools array is the first segment of the prompt prefix and deferred loading is
// not guaranteed, so size it as if it is resident on every request: one sentence of
// what the tool does, one of when to use it, and prose on a parameter only where the
// name, type and enum do not already say it. The schema budget is enforced by review.

const num = { type: "number" };
const str = { type: "string" };
const bool = { type: "boolean" };
// Item types are obvious from the parameter name and mcp.js coerces a string form
// into an array anyway, so the schema stays untyped inside.
const arr = { type: "array" };

const meta = (n) => ({ "anthropic/maxResultSizeChars": n });

export const TOOLS = [
  {
    name: "tabs_context_mcp",
    description:
      "Every tab group with windowId, groupId, name and tab IDs. Only grouped tabs can be driven.",
    inputSchema: { type: "object", properties: { windowId: num } },
    _meta: meta(20000),
  },
  {
    name: "tabs_create_mcp",
    description:
      "Opens a background tab in a new tab group, or in tabId's group. Start each task with your own group and keep its tab IDs; names are only labels.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Name for the new group." },
        tabId: { type: "number", description: "Join this tab's group instead." },
        temporaryContainer: { type: "boolean", description: "Brave only: fresh isolated cookies and storage." },
        incognito: bool,
        windowId: num,
      },
    },
    _meta: meta(20000),
  },
  {
    name: "tabs_close_mcp",
    description: "Closes a grouped tab, or every tab of groupId.",
    inputSchema: { type: "object", properties: { tabId: num, groupId: num } },
    _meta: meta(20000),
  },
  {
    name: "navigate",
    description: "Navigates a tab to a URL, or back/forward.",
    inputSchema: {
      type: "object",
      properties: {
        url: str,
        tabId: num,
        includeSnapshot: bool,
      },
      required: ["url", "tabId"],
    },
    _meta: meta(20000),
  },
  {
    name: "computer",
    description:
      "Mouse, keyboard and screenshots. Prefer `ref` from read_page or find over `coordinate`: exact, and ~15x cheaper than a screenshot. `coordinate` only for canvas, WebGL, drag paths and elements with no ref. Screenshot only to see rendering, never to locate a target.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          enum: [
            "left_click", "right_click", "double_click", "triple_click", "hover",
            "type", "key", "scroll", "scroll_to", "left_click_drag", "zoom",
            "wait", "screenshot",
          ],
        },
        tabId: num,
        ref: str,
        coordinate: arr,
        start_coordinate: arr,
        text: { type: "string", description: "Text to type, or keys." },
        modifiers: str,
        scroll_direction: { enum: ["up", "down", "left", "right"] },
        scroll_amount: num,
        region: { type: "array", description: "[x0,y0,x1,y1]" },
        repeat: num,
        duration: num,
        full: { type: "boolean", description: "Full-page screenshot." },
        includeSnapshot: bool,
      },
      required: ["action", "tabId"],
    },
    // Screenshots ride back as base64 in the same result; a text-shaped ceiling here
    // would guillotine the image, so this one is sized for a 1344x756 JPEG.
    _meta: meta(160000),
  },
  {
    name: "read_page",
    description:
      "Accessibility tree with element refs. Use it, not a screenshot, to locate elements.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: num,
        filter: { enum: ["interactive", "all"], default: "interactive" },
        ref_id: str,
        depth: num,
        max_chars: { type: "number", default: 20000 },
      },
      required: ["tabId"],
    },
    _meta: meta(24000),
  },
  {
    name: "find",
    description:
      "Finds elements by description or visible text.",
    inputSchema: {
      type: "object",
      properties: { query: str, tabId: num },
      required: ["query", "tabId"],
    },
    _meta: meta(20000),
  },
  {
    name: "form_input",
    description:
      "Sets a form element by ref; boolean for checkboxes, option value for selects.",
    inputSchema: {
      type: "object",
      properties: {
        ref: str,
        value: { type: ["string", "number", "boolean"] },
        tabId: num,
        includeSnapshot: bool,
      },
      required: ["ref", "value", "tabId"],
    },
    _meta: meta(20000),
  },
  {
    name: "get_page_text",
    description:
      "The page's readable text. For reading, not locating elements.",
    inputSchema: {
      type: "object",
      properties: { tabId: num, max_chars: { type: "number", default: 20000 } },
      required: ["tabId"],
    },
    _meta: meta(24000),
  },
  {
    name: "resize_window",
    description: "Resizes the tab's emulated viewport.",
    inputSchema: {
      type: "object",
      properties: { width: num, height: num, tabId: num },
      required: ["width", "height", "tabId"],
    },
    _meta: meta(20000),
  },
  {
    name: "javascript_tool",
    description:
      "Evaluates JavaScript in the page. Preinjected __ob: forms/links/inputs/scripts/sinks/shadow/storage/surface.",
    inputSchema: {
      type: "object",
      properties: {
        text: str,
        tabId: num,
        mainWorld: bool,
        allFrames: bool,
        maxChars: { type: "number", default: 4000 },
        filename: str,
      },
      required: ["text", "tabId"],
    },
    _meta: meta(8000),
  },
  {
    name: "page_outline",
    description:
      "Headings, landmarks, forms and tables with refs and y-offsets; flat in page size.",
    inputSchema: { type: "object", properties: { tabId: num }, required: ["tabId"] },
    _meta: meta(20000),
  },
  {
    name: "page_surface",
    description:
      "Attack surface, all frames: forms, hidden inputs, links, params, scripts, iframes, storage, CSP, listeners.",
    inputSchema: {
      type: "object",
      properties: { tabId: num, filename: str },
      required: ["tabId"],
    },
    _meta: meta(12000),
  },
  {
    name: "read_console_messages",
    description:
      "Console messages. Always pass a regex pattern; unfiltered logs are noise.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: num,
        pattern: str,
        onlyErrors: bool,
        limit: num,
        clear: bool,
      },
      required: ["tabId"],
    },
    _meta: meta(20000),
  },
  {
    name: "read_network_requests",
    description:
      "Paginated request index; XHR/Fetch/Document/WebSocket/Other by default.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: num,
        filter: str,
        resourceTypes: arr,
        pageIdx: num,
        pageSize: num,
        includePreserved: bool,
        filename: str,
      },
      required: ["tabId"],
    },
    _meta: meta(20000),
  },
  {
    name: "read_network_request",
    description: "One part of a request from read_network_requests.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: num,
        index: num,
        part: {
          enum: ["request-headers", "request-body", "response-headers", "response-body"],
        },
        filename: str,
      },
      required: ["tabId", "index", "part"],
    },
    _meta: meta(12000),
  },
  {
    name: "sources_list",
    description:
      "DevTools-style tree of everything the tab loaded, by origin with sizes. Pick an origin, then sources_download.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: num,
        browserId: str,
        origin: str,
        glob: str,
        type: {
          enum: ["document", "script", "stylesheet", "image", "font", "xhr", "other"],
        },
        dynamic: { type: "boolean", description: "Also eval'd and late scripts; slower." },
        maxEntries: { type: "number", default: 200 },
      },
      required: ["tabId"],
    },
    _meta: meta(16000),
  },
  {
    name: "sources_download",
    description:
      "Downloads what the tab loaded to a tree on disk and returns counts and the manifest path; read the files with Read and Grep.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: num,
        browserId: str,
        origins: arr,
        include: arr,
        exclude: arr,
        outDir: { type: "string", default: "./source" },
        sourcemaps: { type: "boolean", default: true },
        dynamic: { type: "boolean", description: "Also fetch eval'd and blob: scripts. Slower." },
        maxFiles: { type: "number", default: 300 },
        maxBytes: { type: "number", default: 104857600 },
      },
      required: ["tabId"],
    },
    _meta: meta(20000),
  },
  {
    name: "browsers_list",
    description:
      "Lists the connected browsers and profiles with their ids, brands, labels and tab counts.",
    inputSchema: { type: "object", properties: {} },
    _meta: meta(20000),
  },
  {
    name: "browser_select",
    description:
      "Pins a browser as this session's default so later calls need no browserId. Pass null to clear.",
    inputSchema: {
      type: "object",
      properties: { browserId: { type: ["string", "null"] } },
      required: ["browserId"],
    },
    _meta: meta(20000),
  },
];

// The broker answers these itself; they never reach a browser.
export const BROKER_LOCAL = new Set(["browsers_list", "browser_select"]);
