// pbf and @mapbox/vector-tile ship no types. The app only passes their
// exports opaquely into MapRenderCore.provideLibs(), so ambient any-modules
// are sufficient — no need for @types packages (repo rule: minimum deps).
declare module "pbf";
declare module "@mapbox/vector-tile";
