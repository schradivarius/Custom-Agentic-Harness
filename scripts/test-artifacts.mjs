#!/usr/bin/env node
/**
 * Artifact panel: it renders, it downloads, and it does not break the layout.
 *
 * The panel is a third grid column, so it is the first thing since the sidebar
 * fix with the ability to push the composer off-screen or restore the
 * whole-window scroll. Those two invariants are asserted here alongside the
 * feature itself.
 *
 * Needs a running server (ARTIFACT_BASE, default http://localhost:4300) with
 * at least one conversation that owns artifacts. Skips when Playwright is
 * absent, like the other layout checks.
 */

const BASE = process.env.ARTIFACT_BASE ?? "http://localhost:4300";

let chromium;
try {
  const pw = await import("playwright");
  chromium = pw.chromium ?? pw.default?.chromium;
} catch {
  /*
   * Fall back to CommonJS resolution before giving up.
   *
   * ESM resolution ignores NODE_PATH, so a Playwright installed globally
   * rather than into this project is invisible to a bare `import` even though
   * `require` finds it. Without this the check does not fail, it silently
   * skips — which is worse, because the suite still reports success.
   */
  try {
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const req = createRequire(import.meta.url);
    const pw = await import(pathToFileURL(req.resolve("playwright")).href);
    chromium = pw.chromium ?? pw.default?.chromium;
  } catch {
    /* genuinely absent */
  }
}

if (!chromium) {
  console.log("\nartifacts: skipped — Playwright not installed\n");
  process.exit(0);
}

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
console.log(`\nartifact panel → ${BASE}\n`);

for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });

  // Open the first conversation that has artifacts.
  await page.locator(".conv__main").first().click();
  await page.waitForSelector(".acard", { timeout: 5000 });

  console.log(`${scheme}:`);
  const cards = await page.locator(".acard").count();
  check("inline cards rendered", cards > 0, `found ${cards}`);

  // The card must not spill the artifact's contents into the transcript.
  const firstCardText = await page.locator(".acard").first().innerText();
  check(
    "card shows a handle, not the content",
    !firstCardText.includes("Body.") && firstCardText.length < 120,
    firstCardText.slice(0, 60),
  );

  await page.locator(".acard").first().click();
  await page.waitForSelector(".apanel", { timeout: 5000 });
  check("panel opens", await page.locator(".apanel").isVisible());
  check("panel has a download link", await page.locator(".apanel__dl").isVisible());

  // Layout invariants, with the panel open.
  const m = await page.evaluate(() => {
    const el = (s) => document.querySelector(s);
    const composer = el(".composer");
    const panel = el(".apanel");
    const thread = el(".thread");
    return {
      docScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      composerRight: composer?.getBoundingClientRect().right ?? 0,
      panelLeft: panel?.getBoundingClientRect().left ?? 0,
      threadScrollable: thread ? thread.scrollHeight >= thread.clientHeight : false,
      vw: window.innerWidth,
    };
  });
  check("window still does not scroll", !m.docScrolls);
  check(
    "composer stays inside the thread column",
    m.composerRight <= m.panelLeft + 1,
    `composer right ${Math.round(m.composerRight)} vs panel left ${Math.round(m.panelLeft)}`,
  );
  check("thread keeps its own scroll", m.threadScrollable);

  // Switching to a document artifact, if there is one, must offer a download
  // and no broken preview.
  const docCard = page.locator(".acard", { hasText: "Word document" }).first();
  if (await docCard.count()) {
    await docCard.click();
    await page.waitForSelector(".apanel__note", { timeout: 5000 });
    check("document artifact offers a download instead of a preview", true);

    // Follow the link for real: a 200 with the Word MIME type is the whole
    // feature, and a broken href would be invisible in a screenshot.
    const href = await page.locator(".apanel__note a").getAttribute("href");
    const res = await page.request.get(new URL(href, BASE).toString());
    check("download responds 200", res.status() === 200, String(res.status()));
    check(
      "download is served as a Word document",
      (res.headers()["content-type"] ?? "").includes("wordprocessingml"),
      res.headers()["content-type"] ?? "(none)",
    );
    const body = await res.body();
    check(
      "downloaded bytes are a real zip container",
      body.subarray(0, 4).toString("hex") === "504b0304",
      body.subarray(0, 4).toString("hex"),
    );
  }

  await page.screenshot({
    path: `${process.env.SHOT_DIR ?? "."}/artifacts-${scheme}.png`,
    fullPage: false,
  });
  await ctx.close();
  console.log("");
}

// Narrow viewport: the panel should overlay rather than squeeze three columns.
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "networkidle" });
await page.locator(".conv__main").first().click();
await page.waitForSelector(".acard", { timeout: 5000 });
await page.locator(".acard").first().click();
await page.waitForSelector(".apanel", { timeout: 5000 });
const narrow = await page.evaluate(() => {
  const panel = document.querySelector(".apanel");
  return {
    fixed: getComputedStyle(panel).position === "fixed",
    docScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
  };
});
console.log("narrow (1000px):");
check("panel overlays instead of squeezing", narrow.fixed);
check("window still does not scroll", !narrow.docScrolls);
await ctx.close();

await browser.close();
console.log(`\n${failures === 0 ? "all artifact checks passed" : `${failures} failed`}\n`);
process.exit(failures ? 1 : 0);
