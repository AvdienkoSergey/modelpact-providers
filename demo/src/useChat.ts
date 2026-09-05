/**
 * Every call into the library the demo makes, in one place.
 *
 * The shape it settles on: a session is a resource, not state, so it lives in
 * a ref and is closed by the effect that opened it. What React renders comes
 * from `session.history()` after each turn, which is also what goes to storage
 * — one record, not two.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AiError,
  type AccessKind,
  type AiFailure,
  type AiMessage,
  type AiSession,
  type ContextUsage,
  type Result,
  type Tool,
} from "modelpact";

import { PROVIDERS, type ProviderName } from "./providers";
import { clearRecord, loadRecord, saveRecord, watchRecord } from "./storage";

/** One tool call as the turn made it: the name, and the start of what it said. */
export interface ToolNote {
  readonly name: string;
  readonly preview: string;
}

export interface Chat {
  /** Which branch the provider answered with, or null while it is being asked. */
  readonly access: AccessKind | null;
  /** True once a session opened with the tools that were asked for. */
  readonly openedWithTools: boolean;
  /** The calls the running or last turn made, in order; cleared when a turn starts. */
  readonly toolNotes: readonly ToolNote[];
  readonly record: readonly AiMessage[];
  /** The answer as it arrives; null when no turn is running. */
  readonly streamingAnswer: string | null;
  readonly usage: ContextUsage;
  readonly overflowed: boolean;
  readonly failure: AiFailure | null;
  /** 0..1 while weights are moving, null otherwise. */
  readonly downloadProgress: number | null;
  /** The backend wants weights and has not been told to fetch them. */
  readonly awaitingDownload: boolean;
  readonly ready: boolean;
  readonly startDownload: () => void;
  readonly send: (input: string) => void;
  readonly stop: () => void;
  readonly reset: () => void;
}

/** Opening has a third answer: weights are wanted and nobody has said yes. */
type Opening =
  | { readonly kind: "opened"; readonly session: AiSession }
  | { readonly kind: "refused"; readonly failure: AiFailure }
  | { readonly kind: "awaiting-download" };

const toOpening = (sessionResult: Result<AiSession, AiFailure>): Opening =>
  sessionResult.ok
    ? { kind: "opened", session: sessionResult.value }
    : { kind: "refused", failure: sessionResult.error };

/**
 * Every branch of `ModelAccess`, behind one call.
 *
 * `needs-download` is not opened unasked. On the mock it costs a few hundred
 * milliseconds, but on Chrome's built-in model it is gigabytes, and a person
 * changing a dropdown has not agreed to that. The monitor is subscribed before
 * anything is awaited, which the callback shape is what enforces.
 */
async function openSession(
  providerName: ProviderName,
  history: readonly AiMessage[],
  tools: readonly Tool[],
  isDownloadAllowed: boolean,
  onAccess: (kind: AccessKind) => void,
  onProgress: (progress: number) => void,
): Promise<Opening> {
  // Tools are part of the request, so the answer to "is there a model" is an
  // answer about a model that can run them — and a backend without a tool
  // protocol says `unavailable` here rather than opening without them.
  const modelAccess = await PROVIDERS[providerName].access(
    tools.length === 0 ? {} : { tools },
  );
  onAccess(modelAccess.kind);
  if (modelAccess.kind === "unavailable")
    return { kind: "refused", failure: modelAccess.reason };
  if (modelAccess.kind === "needs-download") {
    if (!isDownloadAllowed) return { kind: "awaiting-download" };
    const sessionResult = await modelAccess.open(
      (monitor) => {
        monitor.ondownloadprogress = (event) => {
          onProgress(event.loaded / event.total);
        };
      },
      { history },
    );
    return toOpening(sessionResult);
  }
  return toOpening(await modelAccess.open({ history }));
}

/** The same tool, with what it says written down as it says it. */
const noteCalls = (tool: Tool, onCall: (note: ToolNote) => void): Tool => ({
  ...tool,
  execute: async (input, signal) => {
    const toolText = await tool.execute(input, signal);
    onCall({ name: tool.name, preview: toolText.slice(0, 80) });
    return toolText;
  },
});

export function useChat(
  providerName: ProviderName,
  tools: readonly Tool[],
): Chat {
  // The conversation a session is opened on. Set by storage on load, and again
  // whenever another tab writes — which is what reopens the session below.
  const [seedRecord, setSeedRecord] =
    useState<readonly AiMessage[]>(loadRecord);
  const [record, setRecord] = useState<readonly AiMessage[]>(seedRecord);
  const [streamingAnswer, setStreamingAnswer] = useState<string | null>(null);
  const [usage, setUsage] = useState<ContextUsage>({ kind: "unknown" });
  const [overflowed, setOverflowed] = useState(false);
  const [failure, setFailure] = useState<AiFailure | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [access, setAccess] = useState<AccessKind | null>(null);
  const [awaitingDownload, setAwaitingDownload] = useState(false);
  const [openedWithTools, setOpenedWithTools] = useState(false);
  const [toolNotes, setToolNotes] = useState<readonly ToolNote[]>([]);
  // The name it was granted for, not a flag: switching backends cannot carry
  // an answer given about a different one.
  const [downloadAllowedFor, setDownloadAllowedFor] =
    useState<ProviderName | null>(null);
  const [ready, setReady] = useState(false);

  const sessionRef = useRef<AiSession | null>(null);
  const turnRef = useRef<AbortController | null>(null);

  useEffect(() => watchRecord(setSeedRecord), []);

  useEffect(() => {
    let openedSession: AiSession | null = null;
    let isLive = true;
    setReady(false);
    setAccess(null);
    setAwaitingDownload(false);
    setOpenedWithTools(false);
    setToolNotes([]);
    setOverflowed(false);
    setFailure(null);
    // The old session's meter belongs to the old session; leaving it up reads
    // as a measurement of the one being opened.
    setUsage({ kind: "unknown" });

    void (async () => {
      const notedTools = tools.map((tool) =>
        noteCalls(tool, (note) => {
          if (isLive) setToolNotes((notes) => [...notes, note]);
        }),
      );
      const opening = await openSession(
        providerName,
        seedRecord,
        notedTools,
        downloadAllowedFor === providerName,
        (kind) => {
          if (isLive) setAccess(kind);
        },
        (progress) => {
          if (isLive) setDownloadProgress(progress);
        },
      );
      setDownloadProgress(null);
      if (!isLive) {
        // Unmounted while opening, or the effect re-ran: this session belongs
        // to nobody, and leaving it open would leave its backend open too.
        if (opening.kind === "opened") opening.session.close();
        return;
      }
      if (opening.kind === "awaiting-download") {
        setAwaitingDownload(true);
        return;
      }
      if (opening.kind === "refused") {
        setFailure(opening.failure);
        return;
      }
      openedSession = opening.session;
      openedSession.oncontextoverflow = () => {
        setOverflowed(true);
      };
      sessionRef.current = openedSession;
      setRecord(openedSession.history());
      setUsage(openedSession.usage());
      setOpenedWithTools(tools.length > 0);
      setReady(true);
    })();

    return () => {
      isLive = false;
      openedSession?.close();
      sessionRef.current = null;
    };
  }, [providerName, seedRecord, downloadAllowedFor, tools]);

  const send = useCallback((input: string) => {
    const currentSession = sessionRef.current;
    if (currentSession === null) return;

    const turnController = new AbortController();
    turnRef.current = turnController;
    setFailure(null);
    setToolNotes([]);
    setStreamingAnswer("");

    void (async () => {
      try {
        const streamResult = await currentSession.promptStream(input, {
          signal: turnController.signal,
        });
        if (!streamResult.ok) {
          setFailure(streamResult.error);
          return;
        }
        // A reader loop, not `for await`: stream iteration is not portable, and
        // leaving such a loop early cancels the generation.
        const reader = streamResult.value.getReader();
        let answer = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          answer += chunk.value;
          setStreamingAnswer(answer);
        }
      } catch (error) {
        // The one place the library throws: a reader has nowhere to put a
        // Result, so an interrupted stream errors with an AiError.
        setFailure(
          error instanceof AiError ? error.failure : { kind: "unknown" },
        );
      } finally {
        setStreamingAnswer(null);
        turnRef.current = null;
        // The record is the library's answer to what happened, so it is read
        // rather than assembled here: an interrupted turn is simply not in it.
        const nextRecord = currentSession.history();
        setRecord(nextRecord);
        setUsage(currentSession.usage());
        saveRecord(nextRecord);
      }
    })();
  }, []);

  const stop = useCallback(() => {
    turnRef.current?.abort();
  }, []);

  const startDownload = useCallback(() => {
    setDownloadAllowedFor(providerName);
  }, [providerName]);

  const reset = useCallback(() => {
    turnRef.current?.abort();
    clearRecord();
    // A new seed record reopens the session; the old one is closed by the cleanup.
    setSeedRecord([]);
  }, []);

  return {
    access,
    openedWithTools,
    toolNotes,
    record,
    streamingAnswer,
    usage,
    overflowed,
    failure,
    downloadProgress,
    awaitingDownload,
    ready,
    send,
    stop,
    reset,
    startDownload,
  };
}
