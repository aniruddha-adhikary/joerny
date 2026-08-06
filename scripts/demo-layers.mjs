/*
 * Emits a set of sample layers that mimic the CPG component-discovery workflow,
 * so you can see joerny render each kind (graph / table / note) and the lineage
 * DAG without a running Joern. Usage:
 *
 *   node scripts/demo-layers.mjs --dir .joerny/current/layers [--stagger 1500]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = valueOf("--dir") ?? ".joerny/current/layers";
const stagger = Number(valueOf("--stagger") ?? "0");
mkdirSync(dir, { recursive: true });

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const now = () => new Date().toISOString();

const layers = [
  {
    id: "entry-points",
    name: "Entry Points",
    kind: "graph",
    derivedFrom: [],
    narration: "12 validated batch-job main() methods (survived ground-truth check against cron/AutoSys).",
    createdAt: now(),
    nodes: Array.from({ length: 12 }, (_, i) => ({
      id: `job.Job${i + 1}`,
      label: `Job${i + 1}`,
      type: "entrypoint",
    })),
    edges: [],
  },
  {
    id: "fan-in-infra",
    name: "High-Fan-In Infra",
    kind: "graph",
    derivedFrom: ["entry-points"],
    narration: "Methods called by 5+ distinct job classes — the SDK layer (email, SFTP, MQ, DB).",
    createdAt: now(),
    nodes: [
      { id: "sdk.SftpClient.upload", label: "SftpClient.upload", type: "infra" },
      { id: "sdk.MqClient.putMessage", label: "MqClient.putMessage", type: "infra" },
      { id: "sdk.Mailer.sendEmail", label: "Mailer.sendEmail", type: "infra" },
      { id: "sdk.Db.getConnection", label: "Db.getConnection", type: "infra" },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `job.Job${i + 1}`, label: `Job${i + 1}`, type: "entrypoint" })),
    ],
    edges: [
      ...[1, 2, 3, 4, 5].map((i) => ({ src: `job.Job${i}`, dst: "sdk.SftpClient.upload", type: "calls" })),
      ...[3, 4, 5, 6, 7, 8].map((i) => ({ src: `job.Job${i}`, dst: "sdk.Db.getConnection", type: "calls" })),
      ...[6, 7, 8, 9].map((i) => ({ src: `job.Job${i}`, dst: "sdk.MqClient.putMessage", type: "calls" })),
      ...[10, 11, 12].map((i) => ({ src: `job.Job${i}`, dst: "sdk.Mailer.sendEmail", type: "calls" })),
    ],
  },
  {
    id: "job-clusters",
    name: "Structural Clusters",
    kind: "table",
    derivedFrom: ["entry-points"],
    narration: "Jobs grouped by identical depth-3 call-tree fingerprint. Each cluster = one component.",
    createdAt: now(),
    columns: ["cluster", "jobs", "shared call-tree"],
    rows: [
      ["sftp-ingest", "Job1, Job2, Job5", "getConnection → readLine → parse → upload"],
      ["mq-dispatch", "Job6, Job7, Job8", "getConnection → executeQuery → putMessage"],
      ["report-mail", "Job10, Job11, Job12", "executeQuery → createRow → sendEmail"],
    ],
  },
  {
    id: "components",
    name: "Target Components",
    kind: "graph",
    derivedFrom: ["fan-in-infra", "job-clusters"],
    narration: "3 components replace 12 legacy jobs (4:1). Mappings show which jobs project into each component.",
    createdAt: now(),
    nodes: [
      { id: "cmp.sftp-ingest", label: "sftp-ingest", type: "component" },
      { id: "cmp.mq-dispatch", label: "mq-dispatch", type: "component" },
      { id: "cmp.report-mail", label: "report-mail", type: "component" },
    ],
    edges: [],
    mappings: [
      { from: "job.Job1", to: "cmp.sftp-ingest", note: "config only" },
      { from: "job.Job2", to: "cmp.sftp-ingest" },
      { from: "job.Job5", to: "cmp.sftp-ingest" },
      { from: "job.Job6", to: "cmp.mq-dispatch" },
      { from: "job.Job10", to: "cmp.report-mail" },
    ],
  },
  {
    id: "summary",
    name: "Findings Summary",
    kind: "note",
    derivedFrom: ["components"],
    narration: "Human-readable wrap-up of the discovery run.",
    createdAt: now(),
    markdown: [
      "## Component Discovery — Summary",
      "",
      "- **12** validated entry points → **3** components (**4:1** reduction).",
      "- SDK layer: `SftpClient`, `MqClient`, `Mailer`, `Db` (survive as-is).",
      "- Cross-cutting: transaction management detected in `mq-dispatch` cluster.",
      "",
      "```yaml",
      "name: Job1",
      "component: sftp-ingest",
      "sink: { table: CORE_TABLE }",
      "```",
      "",
      "> Unknown percentage: **2%** (under the 5% target).",
    ].join("\n"),
  },
];

async function main() {
  for (const layer of layers) {
    const file = join(dir, `${layer.id}.json`);
    writeFileSync(file, JSON.stringify(layer, null, 2));
    console.log(`wrote ${file}`);
    if (stagger > 0) await new Promise((r) => setTimeout(r, stagger));
  }
}

main();
