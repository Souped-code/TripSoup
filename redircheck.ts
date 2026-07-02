async function probe(u: string) {
  try {
    const res = await fetch(u, { redirect: "follow" });
    console.log(`${u}\n  status=${res.status} finalUrl=${res.url.slice(0,100)}\n`);
  } catch (e) {
    console.log(`${u}\n  ERROR ${(e as Error).message}\n`);
  }
}
async function main() {
  await probe("http://google.com");
  await probe("https://maps.app.goo.gl/uf6bYQZ8XkQ8Zt3d7");
}
main();
