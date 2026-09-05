/**
 * The three transports where they will actually live: a browser, through the
 * demo in `demo/`, on the packages as npm hands them over.
 *
 * The vitest suites next to each backend run it against the contract from
 * node, which is where a backend's own logic is checked. This suite checks the
 * things node cannot see. A page is not node — `fetch` held on its own throws
 * `Illegal invocation` in one and works in the other. `LanguageModel` and
 * `navigator.gpu` exist in one and not the other. And the emitted `.d.ts`
 * files, the bundle, and React are between the app and the backend here in a
 * way no unit test reproduces.
 *
 * `playwright.config.ts` boots the demo, so there is nothing to start by hand.
 */

import { expect, test as base, type Page } from "@playwright/test";

const test = base.extend<{ errors: string[] }>({
  // Auto, so every spec below carries it: nothing on the page threw, and
  // nothing was logged as an error, during any of them.
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

const composer = (page: Page) => page.getByPlaceholder("Ask it something");
const sendButton = (page: Page) => page.getByRole("button", { name: "Send" });
const stopButton = (page: Page) => page.getByRole("button", { name: "Stop" });
const messages = (page: Page) => page.locator(".record li");
const chip = (page: Page) => page.locator(".chip");

/** A session is open once the composer takes input. */
async function opened(page: Page): Promise<void> {
  await expect(composer(page)).toBeEnabled({ timeout: 15_000 });
}

/** Send, and wait the turn out. The stop button appearing is the turn starting. */
async function ask(page: Page, input: string): Promise<void> {
  await composer(page).fill(input);
  await sendButton(page).click();
  await expect(stopButton(page)).toBeVisible();
  await expect(sendButton(page)).toBeVisible({ timeout: 20_000 });
}

/**
 * Every backend answers one of three, and a spec that only knows which one it
 * got is a spec that runs anywhere. `unavailable` is a pass: a machine without
 * a daemon, a browser without Gemini Nano and a runner without a GPU are all
 * states the contract has a branch for, and reaching the branch is the claim.
 */
async function landsInAState(
  page: Page,
  providerName: string,
): Promise<string> {
  await page.selectOption("select", providerName);
  await expect(chip(page)).toHaveText(
    /^(ready|fetching weights|unavailable)$/,
    {
      timeout: 30_000,
    },
  );
  const said = await chip(page).innerText();
  if (said === "fetching weights") {
    // Not fetched unasked, whatever the backend: on Chrome's model this is
    // gigabytes, and a dropdown is not consent.
    await expect(
      page.getByRole("button", { name: "Download them" }),
    ).toBeVisible();
    await expect(sendButton(page)).toBeDisabled();
  }
  return said;
}

/**
 * Chromium reports a request it could not make at error level, on its own,
 * which the `errors` fixture would otherwise fail the spec on. A spec that
 * arranged the refusal takes those lines and leaves everything else — anything
 * the app itself logged — for the fixture.
 */
function takeNetworkRefusals(errors: string[]): string[] {
  const refusals = errors.filter((line) => line.includes("net::ERR_"));
  for (const refusal of refusals) errors.splice(errors.indexOf(refusal), 1);
  return refusals;
}

/** Asked from node, not the page: the spec skips rather than fails where no daemon runs. */
async function daemonAnswers(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

/**
 * The promises the contract makes about a session, on the entry the page opens
 * with — the daemon's.
 *
 * There is no mock in this picker to stage them against, and that is the
 * point: the engine's demo has one, and this repository is about what happens
 * when there is something on the other end. The price is that these skip
 * without a daemon, where a mock would have run anywhere.
 */
test.describe("through the daemon", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await daemonAnswers()), "no ollama daemon on 11434");
    await opened(page);
  });

  test("the answer arrives in pieces, and the finished turn is the record", async ({
    page,
  }) => {
    // Long enough to still be arriving when it is read: a stream is only a
    // stream if there is a shorter prefix, and a one-word answer has none.
    await composer(page).fill("Count from one to twenty, in words.");
    await sendButton(page).click();
    await expect(stopButton(page)).toBeVisible();

    // Waiting for a few words rather than for the element — it renders an
    // ellipsis until the first delta lands, and that is a prefix of nothing.
    await page.waitForFunction(
      () =>
        (document.querySelector(".streaming")?.textContent ?? "").length > 20,
    );
    const partial = await page.locator(".streaming").innerText();
    await expect(sendButton(page)).toBeVisible({ timeout: 60_000 });

    const answer = await messages(page).nth(1).innerText();
    expect(answer.startsWith(partial)).toBe(true);
    expect(answer.length).toBeGreaterThan(partial.length);
    await expect(messages(page)).toHaveCount(2);
    await expect(chip(page)).toHaveText("ready");
  });

  test("stopping mid-answer keeps the words out of the record and the session open", async ({
    page,
  }) => {
    await composer(page).fill("Write several paragraphs about the sea.");
    await sendButton(page).click();
    await expect(stopButton(page)).toBeVisible();
    await expect(page.locator(".streaming")).not.toBeEmpty();
    await stopButton(page).click();

    // Also the one assertion that would go red on two copies of the engine in
    // one bundle: this notice is the `aborted` branch, and reaching it means
    // the `AiError` thrown by the reader was `instanceof` the app's own.
    await expect(page.getByText(/not in the record/)).toBeVisible();
    await expect(messages(page)).toHaveCount(0);

    // The session survived it, which is the other half of the promise.
    await ask(page, "Name the capital of France in one word.");
    await expect(messages(page)).toHaveCount(2);
  });

  test("the conversation is still there after a reload", async ({ page }) => {
    await ask(page, "Name the capital of France in one word.");
    const before = await messages(page).allInnerTexts();

    await page.reload();
    await opened(page);
    expect(await messages(page).allInnerTexts()).toEqual(before);
  });

  test("a second tab reads the same conversation and stays in step", async ({
    page,
    context,
  }) => {
    await ask(page, "Name the capital of France in one word.");
    await expect(messages(page)).toHaveCount(2);

    const second = await context.newPage();
    await second.goto("/");
    await opened(second);
    await expect(messages(second)).toHaveCount(2);

    // The `storage` event reaches the first tab, which reopens on the new record.
    await ask(second, "And of Spain, in one word.");
    await expect(messages(page)).toHaveCount(4, { timeout: 30_000 });
  });

  /**
   * A window narrow enough to overflow, declared rather than loaded — which is
   * the only way this dialect has one, and what the mock used to be here for.
   */
  test("a window too narrow for the conversation says so once", async ({
    page,
  }) => {
    await page.selectOption("select", "openai-narrow");
    await opened(page);

    // 64 tokens is narrower than one ordinary turn but wider than the shortest:
    // a one-word answer measures 42 all in, and this one measures 95, so the
    // line is crossed on the first turn rather than eventually (measured).
    const notice = page.getByText(/outgrew the window/);
    await ask(page, "Count from one to twenty, in words.");
    await expect(notice).toHaveCount(1);

    // Once, and once only: the window does not un-overflow, and every turn
    // after the first is over the same line.
    await ask(page, "And of Spain?");
    await expect(notice).toHaveCount(1);
  });
});

/**
 * Ollama, generating, in a page. The only spec here that runs a real model end
 * to end, and the only place `fetch` reaches a daemon from a browser context
 * rather than from node — which is a different `fetch` with a different `this`,
 * and the reason a green vitest run is not enough.
 */
test("the ollama entry reaches a daemon and answers", async ({ page }) => {
  test.skip(!(await daemonAnswers()), "no ollama daemon on 11434");

  await page.selectOption("select", "ollama");
  await expect(chip(page)).toHaveText("ready", { timeout: 30_000 });
  await opened(page);

  await composer(page).fill("Name the capital of France in one word.");
  await sendButton(page).click();
  await expect(sendButton(page)).toBeVisible({ timeout: 60_000 });
  await expect(messages(page)).toHaveCount(2);
  await expect(messages(page).nth(1)).not.toBeEmpty();
});

/**
 * The same daemon in the other dialect: `/v1/chat/completions` rather than
 * `/api/chat`, reached by moving `baseUrl` and nothing else. No key is
 * configured, which is the half of the compatible shape a page can actually
 * show — `apiKey` is optional because a local server wants none.
 */
test("the openai entry reaches a compatible server and answers", async ({
  page,
}) => {
  test.skip(!(await daemonAnswers()), "no ollama daemon on 11434");

  await page.selectOption("select", "openai");
  await expect(chip(page)).toHaveText("ready", { timeout: 30_000 });
  await opened(page);

  await composer(page).fill("Name the capital of France in one word.");
  await sendButton(page).click();
  await expect(sendButton(page)).toBeVisible({ timeout: 60_000 });
  await expect(messages(page)).toHaveCount(2);
  await expect(messages(page).nth(1)).not.toBeEmpty();
});

/**
 * Both HTTP transports with nothing on the other end, which is the branch most
 * people meet first.
 *
 * The connection is refused at the network rather than by skipping this where
 * no daemon runs: that way the specs above and here assert both answers on
 * every machine, a laptop with Ollama installed included. `access` resolves to
 * a branch — never a throw, never a hang — and the `errors` fixture is what
 * says the refused connection surfaced as neither.
 */
test("the http entries say unavailable rather than throwing when nothing answers", async ({
  page,
  errors,
}) => {
  // One route for both: the daemon serves `/api` and `/v1` on the same port.
  await page.route("http://127.0.0.1:11434/**", (route) => route.abort());

  for (const entry of ["ollama", "openai"]) {
    expect(await landsInAState(page, entry)).toBe("unavailable");
    await expect(page.getByText("No model API in this runtime")).toBeVisible();
  }
  // The refusals reached the browser, and the line above is what the app made
  // of them. Everything else stays with the fixture.
  expect(takeNetworkRefusals(errors)).not.toEqual([]);
});

/**
 * Chrome's own, against the platform rather than against a written stand-in.
 *
 * Nothing is downloaded here: the model is gigabytes, and the branch this
 * usually lands on is exactly the one that stops and asks. What it proves is
 * that the real `LanguageModel.availability()` was called and its answer came
 * back as one of the three the contract has — a mapping a node run cannot
 * exercise, because the global is missing there.
 */
test("the prompt-api entry maps the platform's own answer", async ({
  page,
}) => {
  const present = await page.evaluate(
    () => typeof LanguageModel !== "undefined",
  );
  test.skip(!present, "this browser has no Prompt API");

  await landsInAState(page, "prompt-api");
});

/**
 * The second entry point, `modelpact-providers/webgpu`, resolved through its
 * own `exports` on top of `@mlc-ai/web-llm` in a real bundle. Nothing is
 * downloaded: a runner with no GPU answers `unavailable` and one with a GPU
 * stops at the consent button, and both are the claim — the split entry
 * imports, initialises, and answers a branch.
 */
test("the webgpu entry, from the package's second door, lands in a state", async ({
  page,
}) => {
  await landsInAState(page, "webgpu");
});

/**
 * A tool through the whole stack: the request carries it, the session opens
 * with it, the model calls it inside the turn, and what it said — this very
 * page's title — reaches the record.
 *
 * The chip is what says the open session is the one with the tool: the box
 * changes first, and a message sent before the reopen would go to the old
 * session, which has none.
 */
test("a tool reads the page, and what it read reaches the record", async ({
  page,
}) => {
  test.skip(!(await daemonAnswers()), "no ollama daemon on 11434");

  await page.getByLabel("Read the page").check();
  await expect(chip(page)).toHaveText("ready · tools", { timeout: 30_000 });
  await opened(page);

  await ask(page, "Use the pageTitle tool, then answer with the title.");
  // The tool line, not the answer: whether the model then repeats the title in
  // prose is the model's business, and asserting it here would make this spec
  // a measurement of a 350M-parameter model rather than of the plumbing. That
  // the call happened, with the page's own title behind it, is the claim.
  await expect(page.locator(".record li.tool")).toHaveText(
    "pageTitle · modelpact-providers demo",
  );
});

/**
 * The contract's answer for a backend with no tool protocol, which on this
 * side of the split is the WebGPU one: refused at `access`, with `tools: true`
 * on the failure so an app can say which part of the request was the problem
 * rather than showing a tag.
 */
test("a backend without tools refuses the request rather than dropping them", async ({
  page,
}) => {
  await page.getByLabel("Read the page").check();
  await page.selectOption("select", "webgpu");
  await expect(page.getByText(/no tool protocol/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(sendButton(page)).toBeDisabled();

  // Untick it, as the notice says to, and the backend is reachable again.
  await page.getByLabel("Read the page").uncheck();
  await expect(page.getByText(/no tool protocol/)).toHaveCount(0, {
    timeout: 30_000,
  });
});
