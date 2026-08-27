// Platform probe for the Windows CI failure behind Jouzu v0.1.4:
// Node cannot fsync an opened directory handle on Windows, which surfaced as
// `EPERM: operation not permitted, fsync` inside pi-multiloop saveState().
// Informational only — the test suite owns the behavior assertion.
import { mkdtempSync, openSync, fsyncSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ml-fsync-"));
try {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
      console.log(`directory fsync on ${process.platform}: supported`);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    console.log(`directory fsync on ${process.platform}: ${err.code ?? err.message}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
