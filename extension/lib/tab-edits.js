// Retry for the extension's own tab-strip edits (chrome.tabs.update / move / group / remove, chrome.tabGroups.update).
//
// While the human mouse-drags a tab, Chromium refuses those calls with "Tabs cannot be edited right now
// (user may be dragging a tab)". Brave 1.95 also crashed outright (a CHECK, twice) when this extension
// called chrome.tabs.update during such a drag. A drag is over in a moment, so a refused edit is retried
// a few times, spaced out, instead of failing the tool call or leaving an agent tab in front of the
// human. The retries are few and slow on purpose: every extra edit during a drag is another chance of
// that crash, which is also why callers keep their edits to the minimum (never an update "just in case").

const RETRIES = 3;
const BACKOFF_MS = 150;
const DRAGGING = /cannot be edited right now/i;

// edit: () => Promise. Resolves with its result; rethrows any other error at once, and the drag error
// once the retries are spent.
export async function editTabs(edit) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await edit();
    } catch (e) {
      if (attempt >= RETRIES || !DRAGGING.test(String(e?.message || e))) throw e;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
    }
  }
}
