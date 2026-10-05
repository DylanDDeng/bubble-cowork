import { build } from "esbuild";
await build({
  entryPoints: ["src/shared/remote/secure-channel.ts"],
  outfile: "dist-electron/electron/remote/secure-channel.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "warning",
});
