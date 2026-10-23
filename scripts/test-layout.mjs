#!/usr/bin/env node
/**
 * Layout invariant: the window itself never scrolls.
 *
 * The sidebar and the thread each scroll inside their own pane. If the page
 * grows taller than the viewport instead, the sidebar scrolls away with the
 * rest of the document — which is what happens when a flex child keeps its
 * default min-height:auto and refuses to shrink past its content.
 *
 * Needs a running server (LAYOUT_BASE, default http://localhost:4300) and
 * Playwright. Skips cleanly when Playwright is not installed, since it is not
 * a dependency of this project.
 */

const BASE = process.env.LAYOUT_BASE ?? "http://localhost:4300";

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
  console.log("\nlayout: skipped — Playwright not installed\n");
  process.exit(0);
}

const SIZES = [
  [1440, 900], [1340, 700], [1100, 620], [900, 560],
  [1340, 420], [1340, 300],          // short: the case that regressed
  [760, 700], [480, 760],            // narrow: sidebar should step aside
];

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
console.log(`\nlayout invariants → ${BASE}\n`);

for (const [w, h] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".composer__box", { timeout: 15000 });

  const m = await page.evaluate(() => {
    const se = document.scrollingElement;
    const side = document.querySelector(".side");
    const list = document.querySelector(".side__list");
    const shown = side && getComputedStyle(side).display !== "none";
    return {
      vOverflow: se.scrollHeight > se.clientHeight + 1,
      hOverflow: se.scrollWidth > se.clientWidth + 1,
      shown: !!shown,
      sideH: shown ? Math.round(side.getBoundingClientRect().height) : 0,
      viewport: window.innerHeight,
      // The footer carries connection status and the tools list. If the
      // conversation list refuses to shrink, the footer is pushed below the
      // fold — and with overflow hidden it is clipped rather than scrolled
      // to, so it becomes unreachable instead of merely off-screen.
      footBottom: (() => {
        const f = document.querySelector(".side__foot");
        return f ? Math.round(f.getBoundingClientRect().bottom) : 0;
      })(),
    };
  });

  check(`${w}x${h} page does not scroll vertically`, !m.vOverflow);
  check(`${w}x${h} page does not scroll horizontally`, !m.hOverflow);
  if (m.shown) {
    check(
      `${w}x${h} sidebar fits the viewport`,
      m.sideH <= m.viewport + 1,
      `sidebar ${m.sideH}px in a ${m.viewport}px window`,
    );
    check(
      `${w}x${h} sidebar footer stays reachable`,
      m.footBottom > 0 && m.footBottom <= m.viewport + 1,
      `footer bottom at ${m.footBottom}px in a ${m.viewport}px window`,
    );
  }
  await page.close();
}

await browser.close();
console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
