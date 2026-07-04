// Debug-only pipeline driver, gated behind DEBUG_BOARD=1 (same gate as
// /debug/design) so it never appears in a normal production build. The
// interactive part is a client component; this server page only enforces
// the gate. The real greeting/loading/reveal flow is D2.3.
import { notFound } from "next/navigation";
import { PipelineDebug } from "@/ui/pipeline/PipelineDebug";

export default function PipelineDebugPage() {
  if (process.env.DEBUG_BOARD !== "1") notFound();
  return <PipelineDebug />;
}
