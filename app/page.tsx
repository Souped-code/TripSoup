// D2.3 (T3): the real greeting — the product's front door (design.md §8;
// "the landing IS the product"). Replaces the temporary new-trip button
// (moved to /debug/trip in D2.3 T2). Thin route file; all the logic and
// markup lives in the client component so this stays a plain Server
// Component boundary, matching the app/debug/pipeline + PipelineDebug split.
import { Greeting } from "@/ui/greeting/Greeting";

export default function Home() {
  return <Greeting />;
}
