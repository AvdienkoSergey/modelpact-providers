import { useMemo, useState, type FormEvent } from "react";
import type {
  AccessKind,
  AiFailure,
  ContextUsage,
  FailureKind,
  Tool,
  UsageKind,
} from "modelpact";
import { makeMockTool } from "modelpact/tools";

import {
  PROVIDER_NAMES,
  getProviderLabel,
  type ProviderName,
} from "./providers";
import { useChat, type Chat } from "./useChat";

/** One line per branch of `ModelAccess`, which is the whole of that union. */
const ACCESS_LABELS: Record<AccessKind, string> = {
  ready: "ready",
  "needs-download": "fetching weights",
  unavailable: "unavailable",
};

/**
 * Every refusal the vocabulary has, in words a person can read.
 *
 * A `Record` rather than a switch with a default: the default is what lets a
 * kind added upstream reach someone as its own name, and keying by
 * `FailureKind` means the build stops here instead.
 */
const FAILURE_NOTICES: Record<FailureKind, string> = {
  aborted:
    "Stopped. The turn is not in the record, so the words above are gone from it.",
  busy: "One generation at a time on a session",
  "context-overflow":
    "The window is full. Reset, or hand back a shorter conversation.",
  failed: "The backend could not answer",
  "invalid-input": "That message was not accepted",
  "invalid-state": "The page is not fully active",
  "not-allowed": "Blocked by this page's permissions policy",
  unknown: "Something else went wrong",
  unsupported: "No model API in this runtime",
  "unsupported-config": "No model for what was asked for",
  "unsupported-input": "That message was built wrong",
};

/** The two branches with no numbers to draw; `bounded` renders a bar instead. */
const NO_BUDGET_LABELS: Record<Exclude<UsageKind, "bounded">, string> = {
  unknown: "budget unknown",
  unbounded: "no limit",
};

/**
 * The branch until a session is open, and `ready` once one is: however the
 * download branch was reached, a session on the other side of it is ready.
 */
function getStatusLabel(chat: Chat): string {
  if (chat.access === null) return "asking…";
  if (!chat.ready) return ACCESS_LABELS[chat.access];
  // What the session was opened with, not what the box says: the box changes
  // first, and the session that reads the page is the one opened after it.
  return chat.openedWithTools
    ? `${ACCESS_LABELS.ready} · tools`
    : ACCESS_LABELS.ready;
}

/** Three states, three prompts: nothing here should read as "still loading". */
function getPlaceholder(chat: Chat): string {
  if (chat.ready) return "Ask it something";
  return chat.awaitingDownload
    ? "Waiting on the download"
    : "Opening a session…";
}

function explainFailure(failure: AiFailure): string {
  const notice = FAILURE_NOTICES[failure.kind];
  // Only some kinds carry a detail, and narrowing is what says which.
  if (failure.kind === "busy") return `${notice}: ${failure.detail}`;
  if (failure.kind === "unsupported-config" && failure.tools === true)
    return "This backend has no tool protocol. Untick “Read the page” to use it.";
  return notice;
}

/** The one tool the demo offers; an array, so the request either carries it or carries nothing. */
const NO_TOOLS: readonly Tool[] = [];

/**
 * The engine's mock tool with the page's title behind it: enough to show a
 * call happening inside a turn, and nothing for a real page reader to be
 * needed for.
 *
 * Each transport runs it the way it can, which is the one place the six
 * entries visibly differ. The mock calls it when its name is in the message;
 * Ollama asks for it natively and answers under the `tool` role; Chrome hands
 * it to `create()` and calls `execute` itself; the WebGPU backend has no tool
 * protocol and refuses the request at `access`, which is the contract's answer
 * for a backend without one.
 */
const makePageTitleTool = (): Tool =>
  makeMockTool({
    name: "pageTitle",
    description: "The title of the current page.",
    reply: () => document.title,
  });

function Meter({ usage }: { usage: ContextUsage }) {
  if (usage.kind !== "bounded")
    return <span className="meter-text">{NO_BUDGET_LABELS[usage.kind]}</span>;
  const usedShare = Math.min(1, usage.used / usage.total);
  return (
    <span className="meter">
      <span className="meter-bar">
        <span className="meter-fill" style={{ width: `${usedShare * 100}%` }} />
      </span>
      <span className="meter-text">
        {usage.used} / {usage.total}
      </span>
    </span>
  );
}

export function App() {
  const [providerName, setProviderName] = useState<ProviderName>("ollama");
  const [draft, setDraft] = useState("");
  const [readsPage, setReadsPage] = useState(false);
  // Memoised because the hook reopens the session when the tools change, and
  // a fresh array on every render would reopen it on every render.
  const tools = useMemo(
    () => (readsPage ? [makePageTitleTool()] : NO_TOOLS),
    [readsPage],
  );
  const chat = useChat(providerName, tools);
  const isBusy = chat.streamingAnswer !== null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedDraft = draft.trim();
    if (trimmedDraft === "" || isBusy || !chat.ready) return;
    chat.send(trimmedDraft);
    setDraft("");
  };

  return (
    <main>
      <header>
        <h1>modelpact-providers</h1>
        <select
          value={providerName}
          onChange={(event) =>
            setProviderName(event.target.value as ProviderName)
          }
        >
          {PROVIDER_NAMES.map((optionName) => (
            <option key={optionName} value={optionName}>
              {getProviderLabel(optionName)}
            </option>
          ))}
        </select>
        <label className="toggle">
          <input
            type="checkbox"
            checked={readsPage}
            onChange={(event) => setReadsPage(event.target.checked)}
          />
          Read the page
        </label>
        <span className="status">
          <span className="chip">{getStatusLabel(chat)}</span>
          <Meter usage={chat.usage} />
        </span>
        <button type="button" onClick={chat.reset}>
          Reset
        </button>
      </header>

      {chat.awaitingDownload && (
        <p className="notice">
          This backend has no weights on this machine yet.{" "}
          <button type="button" onClick={chat.startDownload}>
            Download them
          </button>
        </p>
      )}
      {chat.downloadProgress !== null && (
        <p className="notice">
          Downloading weights… {Math.round(chat.downloadProgress * 100)}%
        </p>
      )}
      {chat.overflowed && (
        <p className="notice warn">
          The conversation outgrew the window. Older turns are being dropped.
        </p>
      )}

      <ol className="record">
        {chat.record.map((message, index) => (
          <li key={index} className={message.role}>
            {message.content}
          </li>
        ))}
        {chat.toolNotes.map((note, index) => (
          <li key={`tool-${index}`} className="tool">
            {note.name} · {note.preview}
          </li>
        ))}
        {chat.streamingAnswer !== null && (
          <li className="assistant streaming">{chat.streamingAnswer || "…"}</li>
        )}
      </ol>

      {chat.failure !== null && (
        <p className="notice warn">{explainFailure(chat.failure)}</p>
      )}

      <form onSubmit={handleSubmit}>
        <input
          value={draft}
          placeholder={getPlaceholder(chat)}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!chat.ready}
        />
        {isBusy ? (
          <button type="button" onClick={chat.stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!chat.ready}>
            Send
          </button>
        )}
      </form>

      <footer>
        The conversation is in <code>localStorage</code>. Reload and it is still
        here; open a second tab and both stay in step.
      </footer>
    </main>
  );
}
