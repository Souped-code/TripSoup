// D2.3 (T3): the real greeting — the product's front door (design.md §8;
// "the landing IS the product"). Thin route file; all logic/markup lives in
// the client Greeting component. Stays a plain Server Component boundary.
import { Greeting } from "@/ui/greeting/Greeting";

export default function Home() {
  return <Greeting />;
}
