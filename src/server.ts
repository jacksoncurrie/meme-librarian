import { Agent, routeAgentRequest } from "agents";

const FOLDERS = [
  "tech_humor",
  "cats",
  "gym_fails",
  "signs_gone_wrong",
  "dad_jokes"
] as const;

type Folder = (typeof FOLDERS)[number];

const QUERIES = [
  "funny cat memes",
  "hilarious programming memes",
  "gym fail of the day",
  "signs gone wrong funny",
  "dad joke of the day"
];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SEEN_URLS = 500;
const MAX_GALLERY = 200;

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

interface LibrarianState {
  queryIndex: number;
  paused: boolean;
  seenUrls: string[];
  gallery: GalleryItem[];
}

interface TavilyImage {
  url?: string;
  description?: string;
}

interface TavilyResult {
  url?: string;
  images?: TavilyImage[];
}

interface TavilyResponse {
  images?: TavilyImage[];
  results?: TavilyResult[];
}

interface ClefFolderAnswer {
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

interface ClefResponse {
  answers?: {
    folder?: ClefFolderAnswer;
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function extensionFor(contentType: string, url: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const byType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/tiff": "tiff"
  };
  if (byType[type]) return byType[type];
  const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : "jpg";
}

function metadataSafe(value: string): string {
  const cleaned = value.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ");
  return cleaned.trim().slice(0, 200);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractImages(data: TavilyResponse): ImageMeta[] {
  const found: ImageMeta[] = [];
  const push = (image: TavilyImage, fallbackSource: string) => {
    if (!image || typeof image.url !== "string" || !image.url) return;
    found.push({
      url: image.url,
      description: image.description ?? "",
      source_url: fallbackSource || image.url
    });
  };
  for (const image of data.images ?? []) push(image, image.url ?? "");
  for (const result of data.results ?? []) {
    for (const image of result.images ?? []) push(image, result.url ?? "");
  }
  const unique = new Map<string, ImageMeta>();
  for (const image of found) unique.set(image.url, image);
  return [...unique.values()];
}

export class Librarian extends Agent<Env, LibrarianState> {
  initialState: LibrarianState = {
    queryIndex: 0,
    paused: false,
    seenUrls: [],
    gallery: []
  };

  private running = false;

  private emit(payload: Record<string, unknown>): void {
    this.broadcast(JSON.stringify(payload));
  }

  private patchState(patch: Partial<LibrarianState>): void {
    this.setState({ ...this.state, ...patch });
  }

  async runCycle(): Promise<void> {
    if (this.state.paused) {
      this.emit({ type: "phase", phase: "paused" });
      return;
    }
    if (this.running) return;
    this.running = true;

    try {
      const index = this.state.queryIndex % QUERIES.length;
      const query = QUERIES[index];
      this.patchState({ queryIndex: (index + 1) % QUERIES.length });
      this.emit({ type: "phase", phase: "searching", query });

      if (!this.env.TAVILY_API_KEY) {
        this.emit({
          type: "phase",
          phase: "error",
          message: "Tavily key missing"
        });
        return;
      }

      const image = await this.searchImage(query);
      if (!image) {
        this.emit({
          type: "phase",
          phase: "error",
          message: "No images found"
        });
        return;
      }
      this.emit({ type: "phase", phase: "found", image });

      const decision = await this.classify(image, query);
      this.emit({
        type: "phase",
        phase: "deciding",
        folderOptions: [...FOLDERS],
        choice: decision.choice,
        probabilities: decision.probabilities,
        confidence: decision.confidence
      });

      const deduped = this.state.seenUrls.includes(image.url);
      let key = "";
      if (!deduped) {
        key = await this.fileImage(image, decision.choice);
      }

      const id = crypto.randomUUID();
      const filedAt = new Date().toISOString();
      const title = image.description || "Untitled meme";

      if (!deduped && key) {
        const item: GalleryItem = {
          id,
          key,
          url: image.url,
          source: image.source_url,
          folder: decision.choice,
          title,
          probabilities: decision.probabilities,
          filed_at: filedAt
        };
        const seen = [image.url, ...this.state.seenUrls].slice(
          0,
          MAX_SEEN_URLS
        );
        this.patchState({
          seenUrls: seen,
          gallery: [item, ...this.state.gallery].slice(0, MAX_GALLERY)
        });
      }

      this.emit({
        type: "phase",
        phase: "filed",
        id,
        key,
        deduped,
        folder: decision.choice,
        probabilities: decision.probabilities,
        confidence: decision.confidence,
        image,
        title,
        filed_at: filedAt
      });
    } catch (error) {
      console.error(
        "[librarian] cycle error:",
        error instanceof Error ? error.message : String(error)
      );
      this.emit({
        type: "phase",
        phase: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.running = false;
    }
  }

  private async searchImage(query: string): Promise<ImageMeta | null> {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.env.TAVILY_API_KEY}`
      },
      body: JSON.stringify({
        query,
        include_images: true,
        include_image_descriptions: true,
        max_results: 5
      })
    });

    if (!response.ok) {
      throw new Error(`Tavily search failed (${response.status})`);
    }

    const data = (await response.json()) as TavilyResponse;
    const images = extractImages(data);
    if (images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  private async classify(
    image: ImageMeta,
    query: string
  ): Promise<{
    choice: Folder;
    probabilities: Record<string, number>;
    confidence: number;
  }> {
    const criteria: Record<string, null> = {};
    for (const folder of FOLDERS) criteria[folder] = null;

    const result = (await this.env.AI.run("@cf/cloudflare/clef-flash", {
      state: {
        image: image.url,
        description: image.description,
        source: image.source_url,
        query
      },
      questions: {
        folder: {
          type: "choice",
          instructions: "Which folder does this funny image belong in?",
          criteria
        }
      }
    })) as ClefResponse;

    const answer = result.answers?.folder;
    const choice = (FOLDERS as readonly string[]).includes(answer?.choice ?? "")
      ? (answer?.choice as Folder)
      : FOLDERS[0];

    return {
      choice,
      probabilities: answer?.probabilities ?? {},
      confidence: answer?.confidence ?? 0
    };
  }

  private async fileImage(image: ImageMeta, folder: Folder): Promise<string> {
    const response = await fetch(image.url);
    if (!response.ok) {
      throw new Error(`Image download failed (${response.status})`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error("Not an image");
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength >= MAX_IMAGE_BYTES) {
      throw new Error("Image exceeds 10 MB");
    }

    const hash = await sha256Hex(bytes);
    const date = new Date().toISOString().slice(0, 10);
    const ext = extensionFor(contentType, image.url);
    const key = `images/${date}/${hash}.${ext}`;

    await this.env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: {
        url: image.url,
        source: image.source_url,
        folder,
        title: metadataSafe(image.description) || "Untitled meme"
      }
    });

    return key;
  }

  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (request.method === "POST" && path.endsWith("/run-cycle")) {
      this.ctx.waitUntil(this.runCycle());
      return json({ ok: true }, 202);
    }

    if (request.method === "POST" && path.endsWith("/pause")) {
      this.patchState({ paused: true });
      this.emit({ type: "phase", phase: "paused" });
      return json({ ok: true, paused: true });
    }

    if (request.method === "POST" && path.endsWith("/resume")) {
      this.patchState({ paused: false });
      this.emit({ type: "phase", phase: "resumed" });
      return json({ ok: true, paused: false });
    }

    if (request.method === "GET" && path.endsWith("/state")) {
      return json({
        folders: [...FOLDERS],
        gallery: this.state.gallery,
        paused: this.state.paused,
        queryIndex: this.state.queryIndex
      });
    }

    return super.onRequest(request);
  }
}

async function forwardToLibrarian(env: Env, path: string): Promise<Response> {
  const id = env.LIBRARIAN.idFromName("librarian");
  const stub = env.LIBRARIAN.get(id);
  return stub.fetch(`https://librarian${path}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/state") {
      return forwardToLibrarian(env, "/state");
    }

    if (url.pathname.startsWith("/img/")) {
      const key = decodeURIComponent(url.pathname.slice("/img/".length));
      const object = await env.BUCKET.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type":
            object.httpMetadata?.contentType ?? "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable"
        }
      });
    }

    // Manual trigger for the documented local cURL convenience route.
    if (url.pathname === "/agents/librarian/run-cycle") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return forwardToLibrarian(env, "/run-cycle");
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const id = env.LIBRARIAN.idFromName("librarian");
    const stub = env.LIBRARIAN.get(id);
    await stub.fetch("https://librarian/run-cycle", { method: "POST" });
  }
} satisfies ExportedHandler<Env>;
