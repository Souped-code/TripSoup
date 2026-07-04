// POST /api/pipeline — run the paste→plan pipeline and STREAM real progress
// to the browser as Server-Sent Events (D2.2). The client's progress bar and
// Gracie scene bind to these events (Chris-specified: tied to genuine backend
// work, never a spinner that lies).
//
// Event protocol on the text/event-stream:
//   progress: default event, `data: {stage,pct,detail}`  (many)
//   terminal: `event: done`,  `data: <PipelineResult>`   (exactly one, last)
// The terminal result is the generator's RETURN value, so we drive it with
// manual .next() calls — a `for await…of` loop silently discards the return.
import { runPipeline } from "@/lib/pipeline/pipeline";
import { checkRateLimit } from "@/lib/rateLimit";

// A cold matrix + LLM parse can exceed Vercel's default function limit and kill
// the stream mid-flight; raise the ceiling. The pipeline is idempotent (matrix
// pairs cache as they land), so a client retry resumes from cache, not zero.
export const maxDuration = 120;

const encoder = new TextEncoder();
const sse = (data: unknown, event?: string): Uint8Array =>
  encoder.encode(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);

export async function POST(req: Request): Promise<Response> {
  const { limited } = await checkRateLimit("pipeline", req);
  if (limited) {
    return new Response(
      JSON.stringify({
        error: "You've been planning up a storm — give it a short breather and try again soon.",
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  let text: string;
  try {
    const body = (await req.json()) as { text?: unknown };
    if (typeof body.text !== "string" || body.text.trim() === "") {
      return new Response(JSON.stringify({ error: "text must be a non-empty string" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    text = body.text;
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const gen = runPipeline(text);
      try {
        // Drive the generator by hand so we can forward BOTH the yielded
        // progress events and the final returned result.
        while (true) {
          const { value, done } = await gen.next();
          if (done) {
            controller.enqueue(sse(value, "done"));
            break;
          }
          controller.enqueue(sse(value));
        }
      } catch (err) {
        // runPipeline catches its own stage errors and returns them as a
        // {status:"error"} result, so reaching here means an unexpected throw
        // (e.g. the generator itself blew up). Surface it in the same terminal
        // shape the client already handles rather than dropping the stream.
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(sse({ status: "error", stage: "parse", message }, "done"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // defeat proxy buffering so events arrive live
    },
  });
}
