// Per-profile identity. chrome.storage.local is per profile, so a browserId written here is
// distinct for every profile of every Chromium browser without any extra bookkeeping.

const STORAGE_KEY = "identity";

let loading = null;

function load() {
  if (loading) return loading;
  loading = (async () => {
    let rec;
    try {
      rec = (await chrome.storage.local.get(STORAGE_KEY))?.[STORAGE_KEY];
    } catch {}
    if (!rec?.browserId) {
      rec = { browserId: crypto.randomUUID().slice(0, 8), label: null };
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: rec });
      } catch {}
    }
    return rec;
  })();
  return loading;
}

// Chromium forks list themselves *alongside* "Chromium", and the list always carries a GREASE
// entry ("Not/A)Brand"), so pick by name in fork-first order rather than taking brands[0].
function detectBrand() {
  const names = (navigator.userAgentData?.brands || []).map((b) => b.brand);
  for (const want of ["Brave", "Microsoft Edge", "Opera", "Vivaldi", "Google Chrome", "Chromium"]) {
    if (names.includes(want)) return want;
  }
  return "Chromium";
}

async function isAllowedIncognito() {
  try {
    return await chrome.extension.isAllowedIncognitoAccess();
  } catch {
    return false;
  }
}

export async function getIdentity() {
  const rec = await load();
  return {
    browserId: rec.browserId,
    label: rec.label ?? null,
    brand: detectBrand(),
    extVersion: chrome.runtime.getManifest().version,
    // Re-read every time: the user can toggle "Allow in Incognito" without reloading us.
    incognitoAllowed: await isAllowedIncognito(),
  };
}

export async function setLabel(label) {
  const rec = await load();
  rec.label = label == null || label === "" ? null : String(label);
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: rec });
  } catch {}
  return rec.label;
}
