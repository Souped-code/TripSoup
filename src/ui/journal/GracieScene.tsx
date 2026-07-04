import "./journal.css";

export type GracieSceneName =
  | "pin-throw"
  | "route-scribble"
  | "journal"
  | "this-is-fine"
  | "soup-stir";

const FRAME_COUNT = 10; // every sheet in public/gracie/ is 10 frames tiled 10x1

// Frame aspect ratio (width / height) per scene. The meme-parody panel is
// 4:3 like the original; everything else is square. Sheets are scaled by
// background-size, so source resolution never matters here — only aspect.
const SCENE_ASPECT: Record<GracieSceneName, number> = {
  "pin-throw": 1,
  "route-scribble": 1,
  journal: 1,
  "this-is-fine": 4 / 3,
  "soup-stir": 1,
};

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
  const frameWidth = Math.round(size * SCENE_ASPECT[name]);
  const sheetWidth = FRAME_COUNT * frameWidth;
  return (
    <div
      className={["journal-gracie", className].filter(Boolean).join(" ")}
      data-testid={dataTestId}
      role="img"
      aria-label={`Gracie: ${name.replace(/-/g, " ")}`}
      style={{
        width: frameWidth,
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
