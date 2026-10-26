// Build standalone executables with `bun build --compile`.
// Usage: bun scripts/build.ts [target...]   (default: the host platform)
//   targets: bun-linux-x64, bun-linux-arm64, bun-darwin-x64, bun-darwin-arm64
import type { BunPlugin } from "bun";
import path from "node:path";
import pkg from "../package.json";

// The harness adapters load their bridge files with
// `readFile(new URL("./bridge/<file>", import.meta.url))`. A compiled binary
// does not embed files referenced that way (and both adapters would resolve to
// the same bundled path), so rewrite each reference into an embedded-file import.
const embedBridgeAssets: BunPlugin = {
  name: "embed-harness-bridge-assets",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]@ai-sdk[\\/]harness-(?:claude-code|codex)[\\/]dist[\\/]index\.js$/ },
      async ({ path: file }) => {
        let source = await Bun.file(file).text();
        const imports: string[] = [];
        source = source.replace(
          /new URL\((["'])\.\/bridge\/([^"']+)\1,\s*import\.meta\.url\)/g,
          (_, _q, asset: string) => {
            const name = `__bridgeAsset${imports.length}`;
            imports.push(
              `import ${name} from ${JSON.stringify(path.join(path.dirname(file), "bridge", asset))} with { type: "file" };`,
            );
            return name;
          },
        );
        if (imports.length === 0)
          throw new Error(`${file}: no bridge asset references found; the adapter layout changed`);
        return { contents: `${imports.join("\n")}\n${source}`, loader: "js" };
      },
    );
  },
};

// Each target is written to dist/<os>-<arch>/crosscheck, the layout the
// release workflow packages as crosscheck-<version>-<os>-<arch>.tar.gz.
const hostTarget = `bun-${process.platform}-${process.arch}`;
const targets = process.argv.slice(2);
for (const target of targets.length ? targets : [hostTarget]) {
  const outfile = path.join("dist", target.replace(/^bun-/, ""), "crosscheck");
  const result = await Bun.build({
    entrypoints: ["src/cli.ts"],
    compile: { target: target as Bun.Build.CompileTarget, outfile },
    minify: true,
    plugins: [embedBridgeAssets],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`built ${outfile} (crosscheck ${pkg.version})`);
}
