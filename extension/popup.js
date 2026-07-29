// Minimal popup: connection status and the per-profile label (PLAN §2, §7.1). Both come from
// the service worker, which owns identity.js and the native port — nothing is stored here.

const $ = (id) => document.getElementById(id);

function ask(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply) => {
      void chrome.runtime.lastError; // worker asleep or restarting; render what we have
      resolve(reply || null);
    });
  });
}

async function render() {
  const id = await ask({ type: "get_identity" });
  if (!id) {
    $("status").textContent = "extension not responding";
    $("status").className = "off";
    return;
  }
  $("status").textContent = id.connected ? "connected" : "no native host";
  $("status").className = id.connected ? "on" : "off";
  $("brand").textContent = id.brand || "Chromium";
  $("browserId").textContent = id.browserId || "?";
  $("label").value = id.label || "";
}

$("save").addEventListener("click", async () => {
  await ask({ type: "set_label", label: $("label").value.trim() });
  $("saved").classList.add("show");
  setTimeout(() => $("saved").classList.remove("show"), 1200);
});

$("label").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("save").click();
});

render();
