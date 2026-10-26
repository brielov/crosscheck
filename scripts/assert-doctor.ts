// CI helper: fail unless `crosscheck doctor --json` shows the embedded adapter
// bridge files load (credential checks are expected to fail on CI runners).
const [file] = process.argv.slice(2);
const report = (await Bun.file(file!).json()) as {
  checks: { name: string; status: string; detail: string }[];
};
const bridge = report.checks.find((c) => c.name === "adapter bridge files");
if (bridge?.status !== "ok") {
  console.error(`adapter bridge files: ${bridge?.detail ?? "check missing"}`);
  process.exit(1);
}
console.log("adapter bridge files: ok");
