import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";

interface ImageMeta {
  url: string;
  description: string;
  source_url: string;
}

interface GalleryItem {
  id: string;
  key: string;
  url: string;
  source: string;
  folder: string;
  title: string;
  probabilities: Record<string, number>;
  filed_at: string;
}

interface LibraryState {
  folders: string[];
  gallery: GalleryItem[];
  paused: boolean;
  queryIndex: number;
}

type Activity =
  | { id: string; kind: "searching"; query: string }
  | { id: string; kind: "found"; image: ImageMeta }
  | {
      id: string;
      kind: "deciding";
      folderOptions: string[];
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      id: string;
      kind: "filed";
      folder: string;
      title: string;
      key: string;
      deduped: boolean;
    }
  | { id: string; kind: "paused" }
  | { id: string; kind: "resumed" }
  | { id: string; kind: "error"; message: string };

const FOLDER_LABELS: Record<string, string> = {
  tech_humor: "Tech humor",
  cats: "Cats",
  gym_fails: "Gym fails",
  signs_gone_wrong: "Signs gone wrong",
  dad_jokes: "Dad jokes"
};

const DEPLOY_URL =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/jacksoncurrie/meme-librarian";

function folderLabel(folder: string): string {
  return FOLDER_LABELS[folder] ?? folder.replace(/_/g, " ");
}

function sentenceCase(value: string): string {
  if (!value) return value;
  const trimmed = value.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function filedTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function normalizedProbabilities(
  probabilities: Record<string, number>
): Record<string, number> {
  const total = Object.values(probabilities).reduce(
    (sum, value) => sum + (value > 0 ? value : 0),
    0
  );
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(probabilities)) {
    out[key] = total > 0 ? (Math.max(value, 0) / total) * 100 : 0;
  }
  return out;
}

function ProbabilityBars({
  folders,
  probabilities,
  choice
}: {
  folders: string[];
  probabilities: Record<string, number>;
  choice: string;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const normalized = normalizedProbabilities(probabilities);

  return (
    <div className="bars">
      {folders.map((folder) => (
        <div
          key={folder}
          className={`bar-row${folder === choice ? " bar-row-chosen" : ""}`}
        >
          <span className="bar-label">{folderLabel(folder)}</span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{ width: shown ? `${normalized[folder] ?? 0}%` : "0%" }}
            />
          </span>
          <span className="bar-value">
            {Math.round(normalized[folder] ?? 0)}%
          </span>
        </div>
      ))}
    </div>
  );
}

function ActivityItem({ activity }: { activity: Activity }) {
  if (activity.kind === "searching") {
    return (
      <div className="activity">
        <span className="pulse" />
        <div className="activity-body">
          <span className="activity-title">Searching</span>
          <span className="activity-detail">“{activity.query}”</span>
        </div>
      </div>
    );
  }

  if (activity.kind === "found") {
    return (
      <div className="activity">
        <span className="dot" />
        <div className="activity-body">
          <span className="activity-title">Found an image</span>
          <span className="activity-detail">
            {activity.image.description || domainOf(activity.image.url)}
          </span>
          <img
            className="preview"
            src={activity.image.url}
            alt={activity.image.description || "Candidate meme"}
            loading="lazy"
          />
        </div>
      </div>
    );
  }

  if (activity.kind === "deciding") {
    return (
      <div className="activity">
        <span className="dot" />
        <div className="activity-body">
          <span className="activity-title">Deciding on a folder</span>
          <span className="activity-detail">
            Chose {folderLabel(activity.choice)} ·{" "}
            {Math.round(activity.confidence * 100)}% confidence
          </span>
          <ProbabilityBars
            folders={activity.folderOptions}
            probabilities={activity.probabilities}
            choice={activity.choice}
          />
        </div>
      </div>
    );
  }

  if (activity.kind === "filed") {
    return (
      <div className="activity">
        <span className="dot" />
        <div className="activity-body">
          <span className="activity-title">
            Filed into {folderLabel(activity.folder)}
          </span>
          <span className="activity-detail">
            {activity.deduped
              ? "Already filed, skipped duplicate"
              : sentenceCase(activity.title)}
          </span>
        </div>
        <span className="filed-card" aria-hidden="true" />
      </div>
    );
  }

  if (activity.kind === "error") {
    return (
      <div className="activity activity-error">
        <span className="dot dot-error" />
        <div className="activity-body">
          <span className="activity-title">Error</span>
          <span className="activity-detail">{activity.message}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="activity">
      <span className="dot" />
      <div className="activity-body">
        <span className="activity-title">
          {activity.kind === "paused" ? "Cycle paused" : "Cycle resumed"}
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [state, setState] = useState<LibraryState>({
    folders: [],
    gallery: [],
    paused: false,
    queryIndex: 0
  });
  const [filter, setFilter] = useState<string | null>(null);
  const [flashFolder, setFlashFolder] = useState<string | null>(null);
  const activityId = useRef(0);

  const nextId = useCallback(() => {
    activityId.current += 1;
    return String(activityId.current);
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const response = await fetch("/api/state");
      if (!response.ok) return;
      const data = (await response.json()) as LibraryState;
      setState(data);
    } catch {
      // Ignore transient fetch failures
    }
  }, []);

  const push = useCallback((activity: Activity) => {
    setActivities((prev) => [activity, ...prev].slice(0, 60));
  }, []);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (data.type !== "phase") return;
      const id = nextId();

      switch (data.phase) {
        case "searching":
          setActivities((prev) =>
            [
              {
                id,
                kind: "searching",
                query: String(data.query ?? "")
              } as Activity,
              ...prev
            ].slice(0, 60)
          );
          break;
        case "found":
          push({ id, kind: "found", image: data.image as ImageMeta });
          break;
        case "deciding":
          push({
            id,
            kind: "deciding",
            folderOptions: (data.folderOptions as string[]) ?? [],
            choice: String(data.choice ?? ""),
            probabilities: (data.probabilities as Record<string, number>) ?? {},
            confidence: Number(data.confidence ?? 0)
          });
          break;
        case "filed":
          push({
            id,
            kind: "filed",
            folder: String(data.folder ?? ""),
            title: String(data.title ?? ""),
            key: String(data.key ?? ""),
            deduped: Boolean(data.deduped)
          });
          setFlashFolder(String(data.folder ?? ""));
          window.setTimeout(() => setFlashFolder(null), 1200);
          void refreshState();
          break;
        case "paused":
          push({ id, kind: "paused" });
          void refreshState();
          break;
        case "resumed":
          push({ id, kind: "resumed" });
          void refreshState();
          break;
        case "error":
          push({
            id,
            kind: "error",
            message: String(data.message ?? "Unknown error")
          });
          break;
        default:
          break;
      }
    },
    [nextId, push, refreshState]
  );

  useAgent<LibraryState>({
    agent: "Librarian",
    name: "librarian",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onMessage: handleMessage,
    onStateUpdate: useCallback((next: LibraryState) => {
      setState((prev) => ({ ...prev, ...next }));
    }, [])
  });

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  const trigger = useCallback(async (path: string) => {
    try {
      await fetch(`/agents/librarian/librarian/${path}`, { method: "POST" });
    } catch {
      // Ignore; the next cycle or manual retry will surface errors
    }
  }, []);

  const counts: Record<string, number> = {};
  for (const folder of state.folders ?? []) counts[folder] = 0;
  for (const item of state.gallery ?? []) {
    counts[item.folder] = (counts[item.folder] ?? 0) + 1;
  }

  const visible = filter
    ? state.gallery.filter((item) => item.folder === filter)
    : state.gallery;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1 className="title">Meme librarian</h1>
          <span className="subtitle">
            {state.gallery.length} filed · cron every minute
          </span>
          <span className={`status${connected ? " status-on" : ""}`}>
            <span className="status-dot" />
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
        <div className="header-actions">
          <a
            className="source"
            href="https://github.com/jacksoncurrie/meme-librarian"
            target="_blank"
            rel="noreferrer"
          >
            View source
          </a>
          <a
            className="deploy"
            href={DEPLOY_URL}
            target="_blank"
            rel="noreferrer"
          >
            Deploy to Cloudflare
          </a>
        </div>
      </header>

      <main className="layout">
        <section className="panel activity-panel">
          <div className="panel-head">
            <h2>Agent activity</h2>
            <div className="controls">
              <button
                className="btn"
                onClick={() => void trigger("run-cycle")}
                disabled={!connected}
              >
                Run now
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void trigger(state.paused ? "resume" : "pause")}
                disabled={!connected}
              >
                {state.paused ? "Resume" : "Pause"}
              </button>
            </div>
          </div>

          <div className="timeline">
            {activities.length === 0 ? (
              <p className="empty">
                No activity yet. Run a cycle to watch the librarian work.
              </p>
            ) : (
              activities.map((activity) => (
                <ActivityItem key={activity.id} activity={activity} />
              ))
            )}
          </div>
        </section>

        <section className="panel gallery-panel">
          <div className="panel-head">
            <h2>Folders</h2>
          </div>
          <div className="chips">
            <button
              className={`chip${filter === null ? " chip-active" : ""}`}
              onClick={() => setFilter(null)}
            >
              All
              <span className="chip-count">{state.gallery.length}</span>
            </button>
            {(state.folders ?? []).map((folder) => (
              <button
                key={folder}
                className={`chip${filter === folder ? " chip-active" : ""}${
                  flashFolder === folder ? " chip-flash" : ""
                }`}
                onClick={() =>
                  setFilter((current) => (current === folder ? null : folder))
                }
              >
                {folderLabel(folder)}
                <span className="chip-count">{counts[folder] ?? 0}</span>
              </button>
            ))}
          </div>

          <div className="panel-head">
            <h2>Gallery</h2>
          </div>
          {visible.length === 0 ? (
            <p className="empty">Nothing filed here yet.</p>
          ) : (
            <div className="gallery">
              {visible.map((item) => (
                <figure key={item.id} className="card">
                  <img
                    src={`/img/${item.key}`}
                    alt={item.title}
                    loading="lazy"
                  />
                  <figcaption>
                    <span className="card-title">
                      {sentenceCase(item.title)}
                    </span>
                    <span className="card-meta">
                      {domainOf(item.source) || folderLabel(item.folder)} ·{" "}
                      {filedTime(item.filed_at)}
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
