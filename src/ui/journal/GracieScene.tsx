import "./journal.css";

export type GracieSceneName =
  | "pin-throw"
  | "route-scribble"
  | "this-is-fine"
  | "soup-stir";

const FRAME_COUNT = 10; // every sheet in public/gracie/ is 10 frames, 512px, tiled 10x1

/**
 * GracieScene — sprite-sheet player for the mascot's loading scenes
 * (design.md §1 art style, §8 loading surface; plan D1.3.3).
 *
 * Assets: public/gracie/<name>.webp — 10 frames of 512px tiled horizontally,
 * rendered on the flat --paper cream so the rectangle composites invisibly
 * on paper surfaces (no transparency needed). Animation is CSS steps() —
 * no JS timers, no video element. Under prefers-reduced-motion the
 * animation is disabled in journal.css and Gracie holds her first pose,
 * exactly the fallback design.md §6 requires.
 *
 * Server Component: purely presentational.
 */
export function GracieScene({
  name,
  size = 256,
  fps = 8,
  className,
  "data-testid": dataTestId,
}: {
  name: GracieSceneName;
  size?: number;
  fps?: number;
  className?: string;
  "data-testid"?: string;
}) {
  const sheetWidth = FRAME_COUNT * size;
  return (
    <div
      className={["journal-gracie", className].filter(Boolean).join(" ")}
      data-testid={dataTestId}
      role="img"
      aria-label={`Gracie: ${name.replace(/-/g, " ")}`}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(/gracie/${name}.webp)`,
        backgroundSize: `${sheetWidth}px ${size}px`,
        // consumed by the keyframes + animation shorthand in journal.css
        ["--gracie-shift" as string]: `-${sheetWidth}px`,
        ["--gracie-duration" as string]: `${FRAME_COUNT / fps}s`,
      }}
    />
  );
}
