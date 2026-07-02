// De-risking spike runner.
//   GOOGLE_MAPS_API_KEY=xxx npx tsx spike.ts
// Prints each input -> resolved place_id, then the full Stops + failures.

import { resolvePlaces } from "./resolvePlaces";

// Mix: short goo.gl links + full /maps/place URLs + 2 plain names.
// Singapore-centric so coords are easy to eyeball.
const INPUTS: string[] = [
  // --- short share links (RISKIEST: depend on redirect resolution) ---
  "https://maps.app.goo.gl/81DyFDx1oHqroCro6?g_st=ic",
  "https://maps.app.goo.gl/J3VJ4Z2FWUh2dqZ49?g_st=ic",
  "https://maps.app.goo.gl/nnaaQx9h1tHoovab8?g_st=ic",

  // --- full /maps/place URLs with @lat,lng ---
  "https://www.google.com/maps/place/Tiong+Bahru+Bakery/@1.2853,103.8305,17z/data=!3m1!4b1",
  "https://www.google.com/maps/place/Singapore+Botanic+Gardens/@1.3138,103.8159,15z",
  "https://www.google.com/maps/place/Newton+Food+Centre/@1.3121,103.8398,17z",
  "https://www.google.com/maps/place/Lau+Pa+Sat/@1.2805,103.8504,18z",
  "https://www.google.com/maps/place/Singapore+Zoo/@1.4043,103.7930,15z",

  // --- plain place names ---
  "Tiong Bahru Bakery, Singapore",
  "ArtScience Museum, Singapore",
];

async function main() {
  console.log(`Resolving ${INPUTS.length} inputs...\n`);
  const { stops, failures } = await resolvePlaces(INPUTS);

  console.log(`\n=== STOPS (${stops.length}) ===`);
  for (const s of stops) {
    console.log(
      JSON.stringify(
        {
          id: s.id,
          name: s.name,
          location: s.location,
          address: s.address,
          hasHours: s.openingHours != null,
          source: s.source,
        },
        null,
        2
      )
    );
  }

  console.log(`\n=== FAILURES (${failures.length}) ===`);
  if (failures.length === 0) console.log("  (none)");
  for (const f of failures) console.log(`  ${f.source}\n    reason: ${f.reason}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
