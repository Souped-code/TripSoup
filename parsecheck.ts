import { parseMapsUrl } from "./resolvePlaces";
const cases = [
  "https://www.google.com/maps/place/Tiong+Bahru+Bakery/@1.2853,103.8305,17z/data=!3m1!4b1",
  "https://www.google.com/maps/place/Singapore+Botanic+Gardens/@1.3138,103.8159,15z",
  "https://www.google.com/maps/place/Gardens+by+the+Bay/data=!4m2!3m1!1s0x0:0x0!3d1.2816!4d103.8636",
  "https://www.google.com/maps/place/0x31da19a3e2c8a3d1:0x1234/@1.28,103.85,17z",
  "https://www.google.com/maps/search/hawker+centre/@1.30,103.85,15z",
  "https://www.google.com/maps?q=1.2816,103.8636",
  "https://www.google.com/maps?q=Marina+Bay+Sands",
];
for (const c of cases) console.log(JSON.stringify(parseMapsUrl(c)), "  <-", c.slice(0, 60));
